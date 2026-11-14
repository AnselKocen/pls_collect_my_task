const {randomUUID}=require('crypto');
const {EventEmitter}=require('events');

// Only the latest task is retained, in bounded memory. Reconnecting clients get a snapshot.
class LiveTask {
  constructor({maxChars=512*1024,maxMessages=32}={}) {
    this.task=null;this.maxChars=maxChars;this.maxMessages=maxMessages;
    this.streamId=randomUUID();this.revision=0;
    this.events=new EventEmitter();this.events.setMaxListeners(0);this.connections=new Set();
  }
  snapshot() {return this.task ? structuredClone(this.task) : null;}
  current() {return {type:'snapshot',streamId:this.streamId,revision:this.revision,task:this.snapshot()};}
  publish(event) {this.events.emit('update',{...event,streamId:this.streamId,revision:++this.revision});}
  state() {this.publish({type:'snapshot',task:this.snapshot()});}
  start(agent,name) {
    this.task={id:randomUUID(),agent,name,stage:'正在准备任务',status:'running',startedAt:Date.now(),finishedAt:null,error:null,messages:[],truncated:false};
    this.state();return this.task.id;
  }
  progress(stage) {
    if(this.task?.status!=='running' || this.task.stage===stage)return;
    this.task.stage=stage;this.state();
  }
  accept(event) {
    const task=this.task;
    if(!task || task.status!=='running')return;
    if(event.type==='stage')return this.progress(event.label);
    if(!['delta','message'].includes(event.type) || typeof event.text!=='string')return;
    let message=task.messages.find(item => item.id===event.messageId);
    if(!message) {
      message={id:event.messageId,stage:task.stage,phase:event.phase || 'answer',text:''};
      task.messages.push(message);
    }
    if(event.type==='delta')message.text+=event.text;
    else {message.text=event.text;message.phase=event.phase || 'answer';}
    let trimmed=false;
    while(task.messages.length>this.maxMessages){task.messages.shift();trimmed=true;}
    let excess=task.messages.reduce((sum,item) => sum+item.text.length,0)-this.maxChars;
    while(excess>0 && task.messages.length) {
      const oldest=task.messages[0],cut=Math.min(excess,oldest.text.length);
      oldest.text=oldest.text.slice(cut);excess-=cut;trimmed=true;
      if(!oldest.text.length && task.messages.length>1)task.messages.shift();
    }
    if(trimmed)task.truncated=true;
    if(trimmed || event.type==='message')this.state();
    else this.publish({type:'delta',taskId:task.id,message:{id:message.id,stage:message.stage,phase:message.phase},text:event.text});
  }
  finish(error=null) {
    if(!this.task)return;
    this.task.status=error ? 'failed' : 'completed';this.task.finishedAt=Date.now();
    this.task.error=error;this.task.stage=error ? '本次任务未完成，结果未保存' : '已完成并保存';this.state();
  }
  reset() {this.task=null;this.state();}
  mount(app,port) {
    app.use(['/api/ai/task','/api/ai/events'],(req,res,next) => {
      const host=req.get('host');
      if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(host) || (req.get('origin') && req.get('origin')!==`http://${host}`)) {
        return res.status(403).json({error:'任务详情仅允许本机页面访问'});
      }
      next();
    });
    app.get('/api/ai/task',(req,res) => res.set('Cache-Control','no-store').json(this.current()));
    app.get('/api/ai/events',(req,res) => {
      res.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      req.setTimeout(0);res.flushHeaders();this.connections.add(res);
      const send=event => {
        if(res.destroyed || res.writableEnded)return;
        if(res.writableLength>1024*1024){res.destroy();return;}
        res.write('event: task\ndata: '+JSON.stringify(event)+'\n\n');
      };
      res.write('retry: 1500\n\n');
      send(this.current());
      this.events.on('update',send);
      const heartbeat=setInterval(() => {if(!res.destroyed)res.write(': heartbeat\n\n');},15000);heartbeat.unref();
      res.on('close',() => {clearInterval(heartbeat);this.events.off('update',send);this.connections.delete(res);});
    });
  }
  close() {for(const response of this.connections)response.end();this.connections.clear();}
}
module.exports={LiveTask};
