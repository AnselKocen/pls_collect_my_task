const fs=require('node:fs');
const {respond}=require('./fake-model');
if(process.argv.includes('--version')) {console.log((process.env.MEMO_FAKE_AGENT || 'claude')+' test CLI');process.exit(0);}
const appServer=process.argv.includes('app-server');
const acp=process.argv.includes('acp');
const streaming=process.argv.includes('stream-json');
let modelProvider,promptRequestId;
const write=row => process.stdout.write(JSON.stringify(row)+'\n');
const mode=() => process.env.MEMO_FAKE_CC_INVALID_FILE && fs.existsSync(process.env.MEMO_FAKE_CC_INVALID_FILE) ? fs.readFileSync(process.env.MEMO_FAKE_CC_INVALID_FILE,'utf8') : '';
function run(prompt) {
  const task=prompt.match(/^TASK=([^\n]+)/m)?.[1] || 'habit-pool';
  const input=task==='habit-pool' ? {book:prompt} : JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
  if(process.env.MEMO_FAKE_CC_CAPTURE)fs.appendFileSync(process.env.MEMO_FAKE_CC_CAPTURE,JSON.stringify({task,input,agent:process.env.MEMO_FAKE_AGENT,argv:process.argv.slice(2),modelProvider})+'\n');
  if(process.env.MEMO_FAKE_CC_MARKER)fs.writeFileSync(process.env.MEMO_FAKE_CC_MARKER,'started');
  setTimeout(() => {
    const setting=mode();
    if(setting==='hang'){setInterval(()=>{},1000);return;}
    const error=setting==='partial-failure' ? 'unauthorized: login required' : setting===`fail:${task}` ? 'simulated CLI failure' : null;
    let output=setting===task ? 'not JSON' : setting===`blank:${task}` ? '' : setting===`empty:${task}` ? JSON.stringify(task==='graph' ? {nodes:[],edges:[],summaries:[],insights:''} : {habits:[]}) : JSON.stringify(respond(task,input));
    if(setting===`duplicate:${task}`)output=JSON.stringify({...respond(task,input),habits:Array(30).fill('重复的小练习')});
    if(error)output='partial content that must not be saved';
    if(appServer || streaming || acp) {
      const characters=Array.from(output),size=task==='habit-wish-question' ? 8 : Math.max(1,Math.ceil(characters.length/4));let index=0;
      if(streaming)write({type:'stream_event',event:{type:'message_start',message:{id:'answer'}}});
      // A private thinking payload verifies that the UI adapter never forwards it.
      if(acp)write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_THINKING'}}}});
      else if(appServer)write({method:'item/reasoning/textDelta',params:{threadId:'fake-thread',turnId:'fake-turn',itemId:'private',delta:'PRIVATE_THINKING'}});
      else write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE_THINKING'}}});
      const timer=setInterval(() => {
        if(index<characters.length) {
          const text=characters.slice(index,index+size).join('');index+=size;
          if(acp)write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
          else if(appServer)write({method:'item/agentMessage/delta',params:{threadId:'fake-thread',turnId:'fake-turn',itemId:'answer',delta:text}});
          else write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
          return;
        }
        clearInterval(timer);
        if(acp) {
          if(setting==='acp-abrupt'){process.exitCode=0;process.stdin.destroy();return;}
          write({jsonrpc:'2.0',id:promptRequestId,...(error ? {error:{code:-32000,message:error}} : {result:{stopReason:setting==='acp-truncated' ? 'max_tokens' : 'end_turn'}})});
        } else if(appServer) {
          if(!error)write({method:'item/completed',params:{threadId:'fake-thread',turnId:'fake-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:output}}});
          write({method:'turn/completed',params:{threadId:'fake-thread',turn:{id:'fake-turn',status:error ? 'failed' : 'completed',error:error ? {message:error} : null}}});
        } else {
          if(!error)write({type:'assistant',message:{id:'answer',content:[{type:'text',text:output}]}});
          write({type:'result',subtype:error ? 'error_during_execution' : 'success',is_error:Boolean(error),result:error || output});
          process.exitCode=error ? 1 : 0;
        }
      },setting==='stream-slow' ? 150 : 10);
    } else {
      if(error){process.stderr.write(error);process.exitCode=1;return;}
      process.stdout.write(output);
    }
  },mode()==='slow' ? 2500 : 200);
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',data => {
  buffer+=data;
  if(!appServer && !acp)return;
  let position;
  while((position=buffer.indexOf('\n'))>=0) {
    const row=JSON.parse(buffer.slice(0,position));buffer=buffer.slice(position+1);
    if(acp) {
      if(row.jsonrpc!=='2.0')throw new Error('ACP requires a JSON-RPC 2.0 envelope');
      if(row.method==='initialize')write({jsonrpc:'2.0',id:row.id,result:{protocolVersion:1,agentCapabilities:{}}});
      else if(row.method==='session/new')write({jsonrpc:'2.0',id:row.id,result:{sessionId:'fake-session'}});
      else if(row.method==='session/prompt') {
        promptRequestId=row.id;
        run(row.params.prompt.filter(item=>item.type==='text').map(item=>item.text).join(''));
      }
    }
    else if(row.method==='initialize')write({id:row.id,result:{}});
    else if(row.method==='config/read')write({id:row.id,result:{config:JSON.parse(process.env.MEMO_FAKE_CODEX_CONFIG || '{}')}});
    else if(row.method==='configRequirements/read')write({id:row.id,result:{requirements:process.env.MEMO_FAKE_CODEX_HTTP_REJECT ? {modelProvider:'openai'} : null}});
    else if(row.method==='thread/start') {
      const selected=process.argv.find(arg=>arg.startsWith('model_provider='));
      modelProvider=row.params.modelProvider || (selected && JSON.parse(selected.slice('model_provider='.length))) || JSON.parse(process.env.MEMO_FAKE_CODEX_CONFIG || '{}').model_provider || 'openai';
      write({id:row.id,result:{thread:{id:'fake-thread'}}});
    }
    else if(row.method==='turn/start') {
      write({id:row.id,result:{turn:{id:'fake-turn'}}});
      run(row.params.input.filter(item=>item.type==='text').map(item=>item.text).join(''));
    }
  }
});
process.stdin.on('end',()=>{if(appServer || acp)process.exit(0);else run(buffer);});
