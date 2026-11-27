const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LiveTask,MAX_LOG_BYTES}=require('../tasks/live');
const {fixture}=require('./agent-fixture');
const {invokeAgent}=require('../agents');

test('all four assistants emit reply deltas before finishing and omit private thinking',async t => {
  const f=fixture(t);
  for(const id of ['codex','cc','codebuddy','trae']) {
    const events=[];let finished=false;
    const reply=await invokeAgent(id,'fictional book',{cwd:f.dir,env:f.env,onEvent:event => {
      if(event.type==='delta')assert.equal(finished,false);
      events.push(event);
    }});
    finished=true;
    assert.ok(events.filter(event => event.type==='delta').length>=2);
    assert.doesNotMatch(JSON.stringify(events),/PRIVATE_THINKING/);
    const full=events.filter(event => event.type==='message').at(-1);
    assert.equal(full.text,reply);assert.ok(JSON.parse(reply).habits.length);
  }
});

test('live snapshots restore partial output, keep stages and end only after validation',() => {
  const live=new LiveTask(),updates=[];live.events.on('update',event => updates.push(event));
  const id=live.start('codex','整理标签');live.progress('正在等待回答');
  live.accept({type:'delta',messageId:'one',text:'["图'});
  const snapshot=live.snapshot();assert.equal(snapshot.id,id);assert.equal(snapshot.status,'running');
  snapshot.messages[0].text='changed';assert.equal(live.snapshot().messages[0].text,'["图');
  live.accept({type:'delta',messageId:'one',text:'谱"]'});
  live.accept({type:'message',messageId:'one',text:'["图谱"]',phase:'answer'});
  assert.equal(live.snapshot().status,'running','Receiving final text does not imply validated success');
  live.finish();assert.equal(live.snapshot().status,'completed');assert.ok(live.snapshot().finishedAt);
  assert.equal(updates.filter(event => event.type==='delta').length,2);
  live.start('cc','生成图谱');live.accept({type:'delta',messageId:'two',text:'incomplete'});
  live.finish('本次未保存');assert.equal(live.snapshot().status,'failed');assert.equal(live.snapshot().error,'本次未保存');
  live.reset();assert.equal(live.snapshot(),null);
});

test('the retained task output and message count are bounded',() => {
  const live=new LiveTask({maxChars:20,maxMessages:2});live.start('codex','large');
  for(let index=0;index<5;index++)live.accept({type:'delta',messageId:String(index),text:'abcdefghijklmnop'});
  const task=live.snapshot();assert.ok(task.messages.length<=2);assert.ok(task.messages.reduce((n,item)=>n+item.text.length,0)<=20);assert.equal(task.truncated,true);
});

test('stream events and snapshots share a revision that survives task resets',() => {
  const live=new LiveTask(),events=[];live.events.on('update',event=>events.push(event));
  assert.equal(live.current().revision,0);
  live.start('codex','整理标签');
  live.accept({type:'delta',messageId:'answer',text:'partial'});
  const partial=live.current();
  live.finish();live.reset();
  assert.deepEqual(events.map(event=>event.revision),[1,2,3,4]);
  assert.ok(events.every(event=>event.streamId===partial.streamId));
  assert.equal(partial.revision,2);assert.equal(partial.task.messages[0].text,'partial');
  assert.equal(live.current().revision,4);assert.equal(live.current().task,null);
  assert.notEqual(new LiveTask().current().streamId,partial.streamId);
});

function logFixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'memo-live-log-'));
  const logFile=path.join(directory,'latest-ai-task.json');
  const live=new LiveTask({...options,logFile});
  t.after(()=>{live.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,logFile,live,read:()=>JSON.parse(fs.readFileSync(logFile,'utf8')).task};
}

test('the one latest log survives restart, replaces streamed text with its final reply, and carries the result target',t => {
  const {directory,logFile,live,read}=logFixture(t);
  const id=live.start('codex','生成愿望卡池',{type:'habit-pool',step:'generate',source:'wish'});
  live.progress('正在生成习惯卡池');
  live.accept({type:'delta',messageId:'one',text:'公开'});
  live.accept({type:'delta',messageId:'one',text:'回答'});
  live.accept({type:'message',messageId:'one',text:'公开回答',phase:'answer'});
  live.progress('正在校验习惯卡池');live.progress('正在保存习惯卡池');
  live.setTarget({id:'pool-one',generatedAt:'2026-11-26T01:00:00.000Z'});live.finish();
  const saved=read();assert.equal(saved.id,id);assert.equal(saved.messages.length,1);assert.equal(saved.messages[0].text,'公开回答');
  assert.equal(saved.status,'completed');assert.ok(saved.elapsedMs>=0);
  assert.deepEqual(saved.target,{type:'habit-pool',step:'generate',source:'wish',id:'pool-one',generatedAt:'2026-11-26T01:00:00.000Z'});
  assert.deepEqual(saved.stages.map(item=>item.stage),['正在准备任务','正在生成习惯卡池','正在校验习惯卡池','正在保存习惯卡池','已完成并保存']);
  const restarted=new LiveTask({logFile});
  assert.equal(restarted.snapshot().status,'completed');assert.equal(restarted.snapshot().id,id);assert.equal(restarted.snapshot().recovered,true);
  assert.deepEqual(restarted.snapshot().messages,saved.messages);assert.notEqual(restarted.streamId,live.streamId);
  assert.deepEqual(fs.readdirSync(directory),['latest-ai-task.json']);
  live.start('cc','今日摘要',{type:'daily-digest'});
  assert.equal(read().messages.length,0);assert.equal(read().error,null);
  assert.deepEqual(read().target,{type:'daily-digest'});assert.doesNotMatch(fs.readFileSync(logFile,'utf8'),/公开回答|pool-one/);
  live.reset();assert.equal(read(),null);
});

test('a running checkpoint becomes an interrupted failure after restart without counting downtime',t => {
  const {live,logFile,read}=logFixture(t);
  live.start('codex','生成愿望卡池',{type:'habit-pool',step:'generate',source:'wish'});
  live.accept({type:'delta',messageId:'partial',text:'尚未校验的公开回答'});live.flush();
  const saved=read();saved.startedAt=Date.now()-60000;saved.updatedAt=saved.startedAt+1234;
  fs.writeFileSync(logFile,JSON.stringify({version:1,task:saved}));
  const restarted=new LiveTask({logFile});
  const task=restarted.snapshot();assert.equal(task.status,'failed');assert.equal(task.interrupted,true);assert.equal(task.recovered,true);
  assert.match(task.error,/重启|中断/);assert.equal(task.elapsedMs,1234);assert.equal(task.finishedAt,saved.updatedAt);
  assert.equal(task.messages[0].text,'尚未校验的公开回答');assert.equal(read().status,'failed');
  restarted.start('cc','新任务',{type:'graph'});assert.equal(restarted.snapshot().status,'running');
  assert.equal(restarted.snapshot().interrupted,undefined);assert.equal(restarted.snapshot().recovered,undefined);assert.deepEqual(restarted.snapshot().messages,[]);
});

test('persisted messages, stages and physical file size are bounded and truncation survives restoration',t => {
  const {live,logFile,read}=logFixture(t,{maxChars:20,maxMessages:2,maxStages:3});
  live.start('codex','bounded',{type:'graph'});
  for(let index=0;index<8;index++) {
    live.progress('阶段'+index);live.accept({type:'message',messageId:String(index),text:'abcdefghijklmnop',phase:'answer'});
  }
  live.finish('结果未保存');
  const task=read();assert.ok(task.messages.length<=2);assert.ok(task.messages.reduce((sum,item)=>sum+item.text.length,0)<=20);
  assert.equal(task.stages.length,3);assert.equal(task.truncated,true);assert.equal(task.status,'failed');
  const restored=new LiveTask({logFile,maxChars:20,maxMessages:2,maxStages:3});
  assert.deepEqual(restored.snapshot().messages,task.messages);assert.equal(restored.snapshot().truncated,true);
  const large=logFixture(t).live;large.start('codex','large');
  large.accept({type:'message',messageId:'large',phase:'answer',text:'\u0000'.repeat(512*1024+100)});large.finish();
  assert.ok(fs.statSync(large.logFile).size<=MAX_LOG_BYTES);assert.equal(large.snapshot().messages[0].text.length,512*1024);
  assert.ok(fs.statSync(logFile).size<=MAX_LOG_BYTES);
});

test('private event types and phases never enter the latest persisted reply',t => {
  const {live,logFile,read}=logFixture(t);
  live.start('codex','private filtering');
  live.accept({type:'reasoning',messageId:'private',text:'PRIVATE_THINKING'});
  live.accept({type:'delta',messageId:'private',phase:'analysis',text:'PRIVATE_THINKING'});
  live.accept({type:'message',messageId:'summary',phase:'commentary',text:'公开进度说明'});
  live.accept({type:'message',messageId:'answer',phase:'answer',text:'公开最终回答'});live.finish();
  assert.equal(read().messages.length,2);assert.doesNotMatch(fs.readFileSync(logFile,'utf8'),/PRIVATE_THINKING/);
});

test('streaming deltas checkpoint while running and close flushes the remaining tail',async t => {
  const {live,read}=logFixture(t);
  live.start('codex','stream');live.accept({type:'delta',messageId:'one',text:'前半段'});
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(read().messages[0].text,'前半段');
  live.accept({type:'delta',messageId:'one',text:'后半段'});live.close();
  assert.equal(read().messages[0].text,'前半段后半段');assert.equal(live.persistTimer,null);
});

test('corrupt or oversized prior logs do not block a new task and are replaced on start',t => {
  const {logFile}=logFixture(t);t.mock.method(console,'error',()=>{});
  for(const text of ['{broken',JSON.stringify({version:1,task:{id:'bad',status:'completed',startedAt:'not a timestamp'}}),'x'.repeat(MAX_LOG_BYTES+1)]) {
    fs.writeFileSync(logFile,text);const live=new LiveTask({logFile});
    assert.equal(live.snapshot(),null);live.start('cc','fresh');live.finish();
    assert.equal(JSON.parse(fs.readFileSync(logFile,'utf8')).task.status,'completed');live.close();
  }
});

test('an unwritable log cannot turn a validated business result into a failed task',t => {
  const {directory}=logFixture(t);t.mock.method(console,'error',()=>{});
  const notDirectory=path.join(directory,'not-directory');fs.writeFileSync(notDirectory,'file');
  const live=new LiveTask({logFile:path.join(notDirectory,'latest-ai-task.json')});
  assert.doesNotThrow(()=>{live.start('cc','finished');live.finish();});
  assert.equal(live.snapshot().status,'completed');assert.ok(live.persistenceError);live.close();
});
