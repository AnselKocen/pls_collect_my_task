const test=require('node:test'),assert=require('node:assert/strict');
const {createAcpSession}=require('../agents/stream-protocol');

function runAcp({updates=[],stopReason='end_turn',version=1,error,serverRequest}={}) {
  const sent=[],events=[];let session,complete;
  const done=new Promise(resolve=>{complete=resolve;});
  const send=row=>{
    sent.push(row);
    if(!row.method)return;
    queueMicrotask(()=>{
      const respond=result=>session.message({jsonrpc:'2.0',id:row.id,result});
      if(row.method==='initialize')respond({protocolVersion:version});
      else if(row.method==='session/new') {
        if(error)session.message({jsonrpc:'2.0',id:row.id,error});
        else respond({sessionId:'test-session'});
      } else if(row.method==='session/prompt') {
        for(const update of updates)session.message({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-session',...update}});
        if(serverRequest)session.message({jsonrpc:'2.0',id:99,...serverRequest});
        else respond({stopReason});
      }
    });
  };
  session=createAcpSession({send,emit:event=>events.push(event),finish:text=>complete({text}),fail:error=>complete({error}),prompt:'Only summarize this supplied text.',cwd:'/tmp/memo-acp'});
  session.start();
  return done.then(result=>({...result,sent,events}));
}
const chunk=(text,messageId)=>({update:{sessionUpdate:'agent_message_chunk',...(messageId ? {messageId} : {}),content:{type:'text',text}}});

test('ACP keeps public message boundaries and returns the last answer without private or foreign content',{timeout:2000},async()=>{
  const result=await runAcp({updates:[
    chunk('I will summarize the supplied text.','preface'),
    {update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_THINKING'}}},
    {update:{sessionUpdate:'tool_call_update',content:[{type:'text',text:'PRIVATE_TOOL_PAYLOAD'}]}},
    {...chunk('FOREIGN_MESSAGE'),sessionId:'another-session'},
    chunk('{"summary":','answer'),chunk('"整理好了"}','answer')
  ]});
  assert.equal(result.error,undefined);
  assert.deepEqual(JSON.parse(result.text),{summary:'整理好了'});
  assert.deepEqual(result.sent.map(row=>row.method),['initialize','session/new','session/prompt']);
  assert.ok(result.sent.every(row=>row.jsonrpc==='2.0'));
  assert.deepEqual(result.sent[0].params.clientCapabilities,{});
  assert.deepEqual(result.sent[1].params,{cwd:'/tmp/memo-acp',mcpServers:[]});
  assert.deepEqual(result.sent[2].params.prompt,[{type:'text',text:'Only summarize this supplied text.'}]);
  assert.doesNotMatch(JSON.stringify(result.events),/PRIVATE_|FOREIGN_MESSAGE/);
  assert.equal(result.events.filter(event=>event.type==='delta' && event.messageId==='answer').length,2);
});

test('ACP handles missing message IDs but rejects incomplete stop reasons',{timeout:2000},async()=>{
  assert.equal((await runAcp({updates:[chunk('one'),chunk('two')]})).text,'onetwo');
  for(const stopReason of ['max_tokens','max_turn_requests','refusal','cancelled',undefined]) {
    const result=await runAcp({updates:[chunk('{"partial":true}')],stopReason:stopReason || null});
    assert.equal(result.text,undefined);assert.match(result.error.message,/未完整结束/);
  }
});

test('ACP rejects unsupported versions and recognizes localized authentication errors',{timeout:2000},async()=>{
  const mismatch=await runAcp({version:2});
  assert.match(mismatch.error.message,/协议版本不兼容/);
  assert.equal(mismatch.sent.length,1);
  const auth=await runAcp({error:{code:-32000,message:'凭据已过期'}});
  assert.equal(auth.error.message,'AGENT_AUTH:trae');
  assert.equal(auth.sent.length,2);
});

test('ACP denies tool permissions and never provides client filesystem or terminal tools',{timeout:2000},async()=>{
  for(const options of [[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}],[]]) {
    const result=await runAcp({serverRequest:{method:'session/request_permission',params:{sessionId:'test-session',options}}});
    assert.equal(result.text,undefined);assert.match(result.error.message,/交互式/);
    assert.deepEqual(result.sent.at(-1).result.outcome,options.length ? {outcome:'selected',optionId:'deny'} : {outcome:'cancelled'});
  }
  for(const method of ['fs/read_text_file','fs/write_text_file','terminal/create']) {
    const result=await runAcp({serverRequest:{method,params:{sessionId:'test-session'}}});
    assert.equal(result.text,undefined);assert.equal(result.sent.at(-1).error.code,-32601);
  }
});
