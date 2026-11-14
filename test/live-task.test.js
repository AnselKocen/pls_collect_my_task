const test=require('node:test'),assert=require('node:assert/strict');
const {LiveTask}=require('../tasks/live');
const {fixture}=require('./agent-fixture');
const {invokeAgent}=require('../agents');

test('Codex, CC and CodeBuddy emit reply deltas before finishing and omit private thinking',async t => {
  const f=fixture(t);
  for(const id of ['codex','cc','codebuddy']) {
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
