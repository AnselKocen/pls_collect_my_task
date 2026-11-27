const {randomUUID}=require('crypto');
const {EventEmitter}=require('events');
const fs=require('fs');
const path=require('path');

const MAX_LOG_BYTES=4*1024*1024;
const TARGET_TYPES=new Set(['daily-digest','weekly-digest','tag-suggestions','graph','habit-wish','habit-pool']);
const boundedText=(value,size) => typeof value==='string' ? value.slice(0,size) : '';
function targetData(value) {
  if(!value || !TARGET_TYPES.has(value.type))return null;
  const target={type:value.type};
  for(const key of ['id','generatedAt'])if(typeof value[key]==='string' && value[key])target[key]=boundedText(value[key],200);
  if(['purpose','effort','generate'].includes(value.step))target.step=value.step;
  if(['wish','material'].includes(value.source))target.source=value.source;
  return target;
}

// One bounded current task is retained on disk; a new task replaces it. Streaming
// deltas are checkpointed at most every 250ms, and state changes flush immediately.
class LiveTask {
  constructor({maxChars=512*1024,maxMessages=32,maxStages=64,logFile=null}={}) {
    this.task=null;this.maxChars=Math.max(0,Math.min(512*1024,maxChars));
    this.maxMessages=Math.max(1,Math.min(32,maxMessages));this.maxStages=Math.max(1,Math.min(64,maxStages));
    this.logFile=logFile;this.persistTimer=null;this.persistenceError=null;
    this.streamId=randomUUID();this.revision=0;
    this.events=new EventEmitter();this.events.setMaxListeners(0);this.connections=new Set();
    this.load();
  }
  load() {
    if(!this.logFile)return;
    try {
      if(fs.statSync(this.logFile).size>MAX_LOG_BYTES)return;
      const saved=JSON.parse(fs.readFileSync(this.logFile,'utf8'));
      if(saved.version!==1 || !saved.task)return;
      const task=saved.task;
      if(typeof task.id!=='string' || !['running','completed','failed'].includes(task.status) || !Number.isFinite(task.startedAt))return;
      this.task={id:boundedText(task.id,200),agent:boundedText(task.agent,40),name:boundedText(task.name,200),
        stage:boundedText(task.stage,500),status:task.status,startedAt:task.startedAt,
        finishedAt:Number.isFinite(task.finishedAt) ? task.finishedAt : null,
        updatedAt:Number.isFinite(task.updatedAt) ? task.updatedAt : task.startedAt,
        error:task.error ? boundedText(task.error,4000) : null,target:targetData(task.target),
        messages:(Array.isArray(task.messages) ? task.messages : []).filter(item => item && typeof item.text==='string' && ['answer','commentary'].includes(item.phase))
          .slice(-this.maxMessages).map(item => ({id:boundedText(item.id,200),stage:boundedText(item.stage,500),phase:item.phase,text:item.text})),
        stages:(Array.isArray(task.stages) ? task.stages : []).filter(item => item && typeof item.stage==='string' && Number.isFinite(item.at))
          .slice(-this.maxStages).map(item => ({stage:boundedText(item.stage,500),at:item.at})),
        truncated:Boolean(task.truncated),recovered:true};
      if(task.interrupted)this.task.interrupted=true;
      if(Number.isFinite(task.recoveredAt))this.task.recoveredAt=task.recoveredAt;
      this.boundMessages();
      if(this.task.status==='running') {
        // This process did not resume the old CLI. Freeze elapsed time at the
        // last checkpoint rather than counting server downtime as model work.
        this.task.status='failed';this.task.interrupted=true;this.task.recoveredAt=Date.now();
        this.task.finishedAt=Math.max(this.task.startedAt,this.task.updatedAt);
        this.task.error='上次服务中断，任务完成状态未确认；请先查看结果位置，再决定是否重试';
        this.task.stage='上次服务中断，完成状态未确认';
        this.addStage(this.task.stage,this.task.recoveredAt);
        this.flush();
      }
    } catch(error) {
      if(error.code!=='ENOENT')console.error('[AI task log] Unable to read latest task:',error.message);
    }
  }
  snapshot() {
    if(!this.task)return null;
    const task=structuredClone(this.task);
    task.elapsedMs=Math.max(0,(task.finishedAt ?? Date.now())-task.startedAt);
    return task;
  }
  checkpoint(immediate=false) {
    if(!this.logFile)return;
    if(immediate)return this.flush();
    if(this.persistTimer===null) {
      this.persistTimer=setTimeout(() => {this.persistTimer=null;this.flush();},250);
      this.persistTimer.unref();
    }
  }
  flush() {
    if(this.persistTimer!==null){clearTimeout(this.persistTimer);this.persistTimer=null;}
    if(!this.logFile)return;
    const temporary=this.logFile+'.tmp';
    try {
      fs.mkdirSync(path.dirname(this.logFile),{recursive:true});
      const json=JSON.stringify({version:1,task:this.snapshot()});
      if(Buffer.byteLength(json)>MAX_LOG_BYTES)throw new Error('Latest task log exceeds its size limit');
      fs.writeFileSync(temporary,json,{mode:0o600});fs.chmodSync(temporary,0o600);
      fs.renameSync(temporary,this.logFile);this.persistenceError=null;
    } catch(error) {
      try{fs.unlinkSync(temporary);}catch{}
      if(this.persistenceError!==error.message)console.error('[AI task log] Unable to save latest task:',error.message);
      this.persistenceError=error.message;
    }
  }
  touch() {if(this.task)this.task.updatedAt=Date.now();}
  addStage(stage,at=Date.now()) {
    if(!this.task)return;
    this.task.stages.push({stage:boundedText(stage,500),at});
    if(this.task.stages.length>this.maxStages){this.task.stages.splice(0,this.task.stages.length-this.maxStages);this.task.truncated=true;}
  }
  boundMessages() {
    const task=this.task;if(!task)return false;
    let trimmed=false;
    while(task.messages.length>this.maxMessages){task.messages.shift();trimmed=true;}
    let excess=task.messages.reduce((sum,item) => sum+item.text.length,0)-this.maxChars;
    while(excess>0 && task.messages.length) {
      const oldest=task.messages[0],cut=Math.min(excess,oldest.text.length);
      oldest.text=oldest.text.slice(cut);excess-=cut;trimmed=true;
      if(!oldest.text.length && task.messages.length>1)task.messages.shift();
    }
    if(trimmed)task.truncated=true;
    return trimmed;
  }
  current() {return {type:'snapshot',streamId:this.streamId,revision:this.revision,task:this.snapshot()};}
  publish(event) {this.events.emit('update',{...event,streamId:this.streamId,revision:++this.revision});}
  state() {this.touch();this.checkpoint(true);this.publish({type:'snapshot',task:this.snapshot()});}
  start(agent,name,target=null) {
    const now=Date.now();
    this.task={id:randomUUID(),agent:boundedText(agent,40),name:boundedText(name,200),stage:'正在准备任务',status:'running',startedAt:now,finishedAt:null,error:null,
      target:targetData(target),messages:[],stages:[],truncated:false};
    this.addStage(this.task.stage,now);
    this.state();return this.task.id;
  }
  progress(stage) {
    if(this.task?.status!=='running' || this.task.stage===stage)return;
    this.task.stage=boundedText(stage,500);this.addStage(this.task.stage);this.state();
  }
  setTarget(target) {
    if(!this.task)return;
    this.task.target=targetData({...this.task.target,...target});this.state();
  }
  accept(event) {
    const task=this.task;
    if(!task || task.status!=='running')return;
    if(event.type==='stage')return this.progress(event.label);
    if(!['delta','message'].includes(event.type) || typeof event.text!=='string' || (event.phase && !['answer','commentary'].includes(event.phase)))return;
    const messageId=boundedText(event.messageId || 'reply',200);
    let message=task.messages.find(item => item.id===messageId);
    if(!message) {
      message={id:messageId,stage:task.stage,phase:event.phase || 'answer',text:''};
      task.messages.push(message);
    }
    if(event.type==='delta')message.text+=event.text;
    else {message.text=event.text;message.phase=event.phase || 'answer';}
    const trimmed=this.boundMessages();
    if(trimmed || event.type==='message')this.state();
    else {
      this.touch();this.checkpoint();
      this.publish({type:'delta',taskId:task.id,message:{id:message.id,stage:message.stage,phase:message.phase},text:event.text});
    }
  }
  finish(error=null,completedStage='已完成并保存') {
    if(!this.task)return;
    this.task.status=error ? 'failed' : 'completed';this.task.finishedAt=Date.now();
    this.task.error=error ? boundedText(error,4000) : null;this.task.stage=error ? '本次任务未完成，结果未保存' : boundedText(completedStage,500);
    this.addStage(this.task.stage,this.task.finishedAt);this.state();
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
  close() {this.flush();for(const response of this.connections)response.end();this.connections.clear();}
}
module.exports={LiveTask,MAX_LOG_BYTES};
