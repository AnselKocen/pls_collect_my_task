const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','task-stream.js'),'utf8');

function streamHarness() {
  const nodes=new Map();
  for(const id of ['aiTaskModal','aiTaskOutput','aiTaskClose','ccTaskBubble']) {
    const classes=new Set(id==='aiTaskModal' ? ['hidden'] : []);
    nodes.set(id,{
      classList:{contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
      addEventListener() {},focus() {}
    });
  }
  const events=[],requests=[];
  const window={
    addEventListener() {},
    dispatchEvent(event) {
      assert.equal(event.type,'cc-task-update');
      events.push(JSON.parse(JSON.stringify(event.detail.task)));
      return true;
    }
  };
  let stream;
  class EventSource {
    constructor(url) {assert.equal(url,'/api/ai/events');stream=this;this.listeners=new Map();}
    addEventListener(type,listener) {this.listeners.set(type,listener);}
    emit(update) {this.listeners.get('task')({data:JSON.stringify(update)});}
  }
  class CustomEvent {
    constructor(type,options) {this.type=type;this.detail=options.detail;}
  }
  const context={
    window,EventSource,CustomEvent,AbortController,
    document:{hidden:false,getElementById:id=>nodes.get(id) || null,addEventListener() {},querySelectorAll:()=>[]},
    fetch:()=>new Promise(resolve=>requests.push(resolve)),
    requestAnimationFrame:()=>1,
    setTimeout:()=>1,clearTimeout() {},setInterval:()=>1
  };
  vm.runInNewContext(source,context,{filename:'task-stream.js'});
  return {window,stream,events,requests,nodes};
}

function snapshot(revision,task,streamId='main') {
  return {type:'snapshot',streamId,revision,task};
}
function running(id='task-1') {
  return {id,name:'今日摘要',status:'running',stage:'正在等待回答',messages:[]};
}
function delta(revision,text,{streamId='main',taskId='task-1'}={}) {
  return {type:'delta',streamId,revision,taskId,message:{id:'message-1',stage:'正在接收回答',phase:'answer'},text};
}

test('accepted live task snapshots and deltas reach the mascot while details are closed',() => {
  const harness=streamHarness();
  harness.stream.emit(snapshot(1,running()));
  assert.equal(harness.nodes.get('aiTaskModal').classList.contains('hidden'),true);
  assert.equal(harness.window._ccLatestTask.id,'task-1','the scene can recover a task received before mounting');
  assert.equal(harness.events.length,1);
  harness.stream.emit(delta(2,'正在生成摘要'));
  assert.equal(harness.events.length,2);
  assert.equal(harness.events[1].messages[0].text,'正在生成摘要');
  assert.equal(harness.window._ccLatestTask.messages[0].text,'正在生成摘要');
  harness.stream.emit(snapshot(3,{...running(),status:'completed',stage:'已完成并保存'}));
  assert.equal(harness.events.at(-1).status,'completed');
  harness.stream.emit(snapshot(4,null));
  assert.equal(harness.events.at(-1),null);
  assert.equal(harness.window._ccLatestTask,null,'a cleared task releases the mounted scene too');
});

test('repeated, out-of-order, gapped and retired-stream events never update the mascot',() => {
  const harness=streamHarness();
  harness.stream.emit(snapshot(3,running()));
  harness.stream.emit(snapshot(2,{...running(),status:'failed'}));
  harness.stream.emit(snapshot(3,{...running(),status:'completed'}));
  harness.stream.emit(delta(5,'missing revision four'));
  harness.stream.emit(delta(4,'different task',{taskId:'other-task'}));
  assert.equal(harness.events.length,1);
  assert.equal(harness.window._ccLatestTask.status,'running');
  harness.stream.emit(delta(4,'valid output'));
  assert.equal(harness.events.length,2);
  harness.stream.emit(snapshot(0,running('task-2'),'replacement'));
  assert.equal(harness.window._ccLatestTask.id,'task-2');
  harness.stream.emit(snapshot(20,{...running(),status:'failed'}));
  assert.equal(harness.events.length,3,'events from the old connection cannot overwrite a restarted server');
  assert.equal(harness.window._ccLatestTask.id,'task-2');
});

test('a connection interruption preserves the real task status and polling can restore it',async () => {
  const harness=streamHarness();
  harness.stream.emit(snapshot(1,running()));
  harness.stream.onerror();
  assert.equal(harness.events.length,1,'disconnecting is not a failed task');
  assert.equal(harness.window._ccLatestTask.status,'running');
  harness.requests[0]({ok:true,json:async()=>snapshot(2,{...running(),stage:'正在接收回答',messages:[{id:'answer',text:'已收到部分内容'}]})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(harness.events.length,2);
  assert.equal(harness.events[1].status,'running');
  assert.equal(harness.events[1].messages[0].text,'已收到部分内容');
});
