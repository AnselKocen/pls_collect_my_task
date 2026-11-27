// Exercise task navigation and silently stalled streams with fictional in-memory snapshots.
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-stream-recovery-'));
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
let window;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=code=>window.webContents.executeJavaScript(code);
async function until(code) {
  const end=Date.now()+6500;
  while(Date.now()<end){if(await read(code))return;await delay(25);}
  throw new Error('UI recovery timed out: '+code);
}
const snapshot=(revision,status='running',text='')=>({
  type:'snapshot',streamId:'server-one',revision,
  task:{id:'fictional-task',agent:'codex',name:'整理标签',stage:status==='running'?'正在等待回答':'已完成并保存',status,
    target:{type:'tag-suggestions',...(status==='completed'?{generatedAt:'2026-01-01T12:00:00.000Z'}:{})},
    startedAt:Date.now()-3000,finishedAt:status==='completed'?Date.now():null,error:null,truncated:false,
    messages:text?[{id:'answer',phase:'answer',stage:'正在等待回答',text}]:[]}
});
async function setSnapshot(value) {await read(`window.fakeSnapshot=${JSON.stringify(value)}`);}
async function emit(value) {await read(`window.fakeSource.listener({data:${JSON.stringify(JSON.stringify(value))}})`);}
const textCode='window.getCurrentAITask()?.messages?.[0]?.text';
const noVisibleLinks='[...document.querySelectorAll("[data-ai-task-details]")].every(button=>button.hidden)';
async function run() {
  const page=path.join(root,'index.html');
  fs.writeFileSync(page,`<!doctype html><html><body>
    <div id="ccTaskBubble"><button data-ai-task-details>前往查看</button></div>
    <button id="tagSuggestGenBtn">生成标签建议</button><button id="weeklyGenBtn">生成周总结</button><button id="digestRegenBtn">生成摘要</button>
    <style>.hidden,[hidden]{display:none}</style><script>
    window.fakeSnapshot={type:'snapshot',streamId:'server-one',revision:0,task:null};
    window.navigationCalls=[];window.navigateToAITaskResult=task=>{window.navigationCalls.push(structuredClone(task));return true;};
    window.notices=[];window.showToast=text=>window.notices.push(text);
    window.fetch=async function(url,options) {
      if(url!=='/api/ai/task' || options.cache!=='no-store')throw new Error('Unexpected request');
      const captured=structuredClone(window.fakeSnapshot);
      if(window.holdNextFetch) {
        window.holdNextFetch=false;
        await new Promise(resolve=>{window.releaseFetch=resolve;});
      }
      return {ok:true,json:async()=>captured};
    };
    window.EventSource=class {
      constructor(){window.fakeSource=this;queueMicrotask(()=>this.onopen?.());}
      addEventListener(type,listener){if(type==='task')this.listener=listener;}
    };
    </script><script src="file://${path.join(__dirname,'../public/task-stream.js')}"></script></body></html>`);
  window=new BrowserWindow({show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await window.loadFile(page);
  await read('window.fakeSource.onopen()');
  await setSnapshot(snapshot(1));
  await until('window.getCurrentAITask()?.status==="running"');
  await until(noVisibleLinks);
  assert.equal(await read('document.querySelector("#digestRegenBtn + [data-ai-task-details]")'),null);
  assert.equal(await read('window.openAITaskDestination()'),false);
  assert.equal(await read('window.navigationCalls.length'),0);
  const initialCompleted=snapshot(2,'completed');
  await setSnapshot(initialCompleted);await emit(initialCompleted);
  await until('!document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden');
  assert.equal(await read('document.querySelector("#weeklyGenBtn + [data-ai-task-details]").hidden'),true);
  await read('document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").click()');
  await until('window.navigationCalls.length===1');
  assert.equal(await read('window.navigationCalls[0].target.type'),'tag-suggestions');
  assert.equal(await read('document.getElementById("aiTaskModal")'),null);

  // No SSE events arrive, even though the connection reports open. Polling still syncs the mascot.
  await setSnapshot(snapshot(3,'running','fictional partial'));
  await until(textCode+'==="fictional partial"');
  await until(noVisibleLinks);
  assert.equal(await read('window._ccLatestTask.status'),'running');
  const beforeRunning=await read('window.navigationCalls.length');
  assert.equal(await read('window.openAITaskDestination()'),false);
  assert.equal(await read('window.navigationCalls.length'),beforeRunning);
  assert.equal(await read('document.body.textContent.includes("fictional partial")'),false);

  // A delayed frame must not duplicate an answer already present in a snapshot.
  await emit({type:'delta',streamId:'server-one',revision:3,taskId:'fictional-task',message:{id:'answer'},text:'fictional partial'});
  assert.equal(await read(textCode),'fictional partial');

  // A missing delta is repaired by a full snapshot, without appending an incomplete tail.
  await setSnapshot(snapshot(5,'running','fictional partial with missing middle'));
  await emit({type:'delta',streamId:'server-one',revision:5,taskId:'fictional-task',message:{id:'answer'},text:'middle'});
  await until(textCode+'==="fictional partial with missing middle"');

  // A click uses the known task immediately even while its background refresh is blocked.
  await read('window.holdNextFetch=true;window.releaseFetch=null;void window.refreshCurrentAITask()');
  await until('typeof window.releaseFetch==="function"');
  const completed=snapshot(6,'completed','fictional final answer');
  await emit(completed);
  assert.equal(await read('window.openAITaskDestination()'),true);
  assert.equal(await read('window.navigationCalls.at(-1).status'),'completed');
  await read('window.releaseFetch()');
  await until('window.getCurrentAITask()?.status==="completed"');
  await delay(100);
  assert.equal(await read(textCode),'fictional final answer');
  await setSnapshot(completed);
  await read('document.querySelector("#ccTaskBubble [data-ai-task-details]").click()');
  assert.equal(await read('window.navigationCalls.at(-1).target.generatedAt'),completed.task.target.generatedAt);

  // Recover completion entirely by polling despite an apparently open stream.
  await emit(snapshot(7));await setSnapshot(snapshot(8,'completed','fictional saved result'));
  await until(textCode+'==="fictional saved result" && window._ccLatestTask.status==="completed"');
  await read('window.fakeSource.onerror()');

  // A local request may begin before SSE. Its button cannot open the preceding task.
  await read('window.markAITaskPending({type:"weekly-digest"},"new request")');
  assert.equal(await read(noVisibleLinks),true);
  assert.equal(await read('document.querySelector("#weeklyGenBtn + [data-ai-task-details]").hidden'),true);
  assert.equal(await read('document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden'),true);
  const before=await read('window.navigationCalls.length');
  assert.equal(await read('window.openAITaskDestination()'),false);
  assert.equal(await read('window.navigationCalls.length'),before);
  // An HTTP result supplies its exact identity even if the live snapshot is delayed.
  const localTarget={type:'weekly-digest',generatedAt:'2026-01-02T12:00:00.000Z'};
  await read(`window.setAITaskNavigationResult('new request',${JSON.stringify(localTarget)});window.finishAITaskPending('new request',true)`);
  assert.equal(await read('document.querySelector("#weeklyGenBtn + [data-ai-task-details]").hidden'),false);
  assert.equal(await read('window.openAITaskDestination()'),true);
  assert.deepEqual(await read('window.navigationCalls.at(-1).target'),localTarget);
  const next=snapshot(9,'completed','new weekly answer');next.task.id='new-weekly';next.task.target=localTarget;
  await setSnapshot(next);await emit(next);
  await until('window.getCurrentAITask()?.id==="new-weekly" && !document.querySelector("#weeklyGenBtn + [data-ai-task-details]").hidden');
  assert.equal(await read('window.openAITaskDestination()'),true);
  assert.equal(await read('window.navigationCalls.at(-1).id'),'new-weekly');

  // Failed tasks keep their existing retry UI; they never expose a result link.
  const failed=snapshot(10,'failed');failed.task.id='failed-task';failed.task.error='fictional failure';
  await setSnapshot(failed);await emit(failed);await until(noVisibleLinks);
  const beforeFailed=await read('window.navigationCalls.length');
  assert.equal(await read('window.openAITaskDestination()'),false);
  assert.equal(await read('window.navigationCalls.length'),beforeFailed);

  // Today's summary already lives on the home page, so even its completion has no result link.
  const daily=snapshot(11,'completed','fictional daily result');daily.task.id='daily-task';
  daily.task.target={type:'daily-digest',generatedAt:'2026-01-03T12:00:00.000Z'};
  await setSnapshot(daily);await emit(daily);await until(noVisibleLinks);
  assert.equal(await read('document.querySelector("#digestRegenBtn + [data-ai-task-details]")'),null);
  assert.equal(await read('window.openAITaskDestination()'),false);
  assert.equal(await read('window.navigationCalls.length'),beforeFailed);

  // A server restart starts a fresh revision sequence; delayed old events stay ignored.
  const restarted={...snapshot(0,'completed','after restart'),streamId:'server-two'};
  await setSnapshot(restarted);await read('window.dispatchEvent(new Event("focus"))');
  await until(textCode+'==="after restart"');
  await emit(snapshot(99,'running','stale old server'));
  assert.equal(await read(textCode),'after restart');

  // Regression: polling an older server must never switch off its live deltas.
  const legacy=snapshot(1,'running','legacy partial');delete legacy.streamId;delete legacy.revision;
  await setSnapshot(legacy);await read('window.dispatchEvent(new Event("focus"))');
  await until(textCode+'==="legacy partial"');
  let streamed='legacy partial';
  for(const text of [' one',' two',' three']) {
    await emit({type:'delta',taskId:'fictional-task',message:{id:'answer'},text});streamed+=text;
    await until(textCode+'==='+JSON.stringify(streamed));
    assert.equal(await read('window._ccLatestTask.status'),'running');
  }
  legacy.task.status='completed';legacy.task.messages[0].text=streamed;
  await setSnapshot(legacy);await read('window.dispatchEvent(new Event("focus"))');
  await until('window._ccLatestTask.status==="completed"');

  // Browsers without EventSource still have navigation and completion snapshots.
  const noStream=fs.readFileSync(page,'utf8').replace('constructor(){window.fakeSource=this;queueMicrotask(()=>this.onopen?.());}',"constructor(){throw new Error('Streaming unavailable');}");
  fs.writeFileSync(page,noStream);await window.loadFile(page);
  await setSnapshot(snapshot(1,'completed','snapshot only'));
  await read('window.dispatchEvent(new Event("focus"))');
  await until('!document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden');
  assert.equal(await read('window.openAITaskDetails()'),true);
  assert.equal(await read('window.navigationCalls.at(-1).target.generatedAt'),completed.task.target.generatedAt);
  assert.equal(await read(textCode),'snapshot only');
  assert.equal(await read('document.getElementById("aiTaskModal")'),null);
  console.log(JSON.stringify({silentStreamRecovery:true,completionRecovered:true,duplicateDeltaIgnored:true,missingDeltaRecovered:true,immediateCompletedNavigationWithStalledFetch:true,stalePollIgnored:true,pendingCannotOpenPreviousTask:true,httpResultIdentity:true,completedOnlyLinks:true,runningAndFailedCannotNavigate:true,dailyAnchorAbsent:true,featureScopedButtons:true,restartRecovered:true,legacyStreamingAfterPoll:true,noStreamingFallback:true,noTranscriptModal:true}));
}
app.whenReady().then(run).catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  window?.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);
});
