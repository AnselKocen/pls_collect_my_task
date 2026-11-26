// Exercise a silently stalled stream without sending any records to an AI service.
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
    startedAt:Date.now()-3000,finishedAt:status==='completed'?Date.now():null,error:null,truncated:false,
    messages:text?[{id:'answer',phase:'answer',stage:'正在等待回答',text}]:[]}
});
async function setSnapshot(value) {await read(`window.fakeSnapshot=${JSON.stringify(value)}`);}
async function emit(value) {await read(`window.fakeSource.listener({data:${JSON.stringify(JSON.stringify(value))}})`);}
async function run() {
  const page=path.join(root,'index.html');
  fs.writeFileSync(page,`<!doctype html><html><body>
    <div id="ccTaskBubble"></div>
    <button id="tagSuggestGenBtn">生成</button>
    <div id="aiTaskModal" class="hidden"><button id="aiTaskClose">关闭</button>
      <h3 id="aiTaskTitle"></h3><span id="aiTaskStatus"></span><p id="aiTaskMeta"></p>
      <div id="aiTaskStage"></div><p id="aiTaskConnection"></p><div id="aiTaskOutput" tabindex="0"></div>
    </div><style>.hidden{display:none}</style><script>
    window.fakeSnapshot={type:'snapshot',streamId:'server-one',revision:0,task:null};
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
  await until('!document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden');
  await read('document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").click()');
  await until('document.querySelector(".ai-task-empty")?.textContent.includes("正在等待回答")');

  // No SSE events are delivered, even though the connection reports open.
  await setSnapshot(snapshot(3,'running','fictional partial'));
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="fictional partial"');
  assert.equal(await read('document.getElementById("aiTaskStatus").dataset.status'),'running');

  // A delayed stream frame must not duplicate text already present in the snapshot.
  await emit({type:'delta',streamId:'server-one',revision:3,taskId:'fictional-task',message:{id:'answer'},text:'fictional partial'});
  assert.equal(await read('document.querySelector("#aiTaskOutput pre").textContent'),'fictional partial');

  // A missing delta is repaired by a full snapshot, without appending an incomplete tail.
  await setSnapshot(snapshot(5,'running','fictional partial with missing middle'));
  await emit({type:'delta',streamId:'server-one',revision:5,taskId:'fictional-task',message:{id:'answer'},text:'middle'});
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="fictional partial with missing middle"');

  // Delay a poll response until after a newer completion event has arrived.
  await read('window.holdNextFetch=true;window.releaseFetch=null;document.getElementById("aiTaskClose").click();document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").click()');
  await until('typeof window.releaseFetch==="function"');
  const completed=snapshot(6,'completed','fictional final answer');
  await emit(completed);
  await read('window.releaseFetch()');
  await until('document.getElementById("aiTaskStatus").dataset.status==="completed"');
  await delay(100);
  assert.equal(await read('document.querySelector("#aiTaskOutput pre").textContent'),'fictional final answer');
  await setSnapshot(completed);

  // Recover a later completion entirely by polling despite an apparently open stream.
  await emit(snapshot(7));await setSnapshot(snapshot(8,'completed','fictional saved result'));
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="fictional saved result" && document.getElementById("aiTaskStatus").dataset.status==="completed"');
  await read('window.fakeSource.onerror()');

  // A server restart starts a fresh revision sequence; delayed old events stay ignored.
  const restarted={...snapshot(0,'completed','after restart'),streamId:'server-two'};
  await setSnapshot(restarted);await read('window.dispatchEvent(new Event("focus"))');
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="after restart"');
  await emit(snapshot(99,'running','stale old server'));
  assert.equal(await read('document.querySelector("#aiTaskOutput pre").textContent'),'after restart');

  // Regression: polling an older server must never switch off its live deltas.
  const legacy=snapshot(1,'running','legacy partial');delete legacy.streamId;delete legacy.revision;
  await setSnapshot(legacy);await read('window.dispatchEvent(new Event("focus"))');
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="legacy partial"');
  let streamed='legacy partial';
  for(const text of [' one',' two',' three']) {
    await emit({type:'delta',taskId:'fictional-task',message:{id:'answer'},text});streamed+=text;
    await until(`document.querySelector('#aiTaskOutput pre')?.textContent===${JSON.stringify(streamed)}`);
    assert.equal(await read('document.getElementById("aiTaskStatus").dataset.status'),'running');
  }
  legacy.task.status='completed';legacy.task.messages[0].text=streamed;
  await setSnapshot(legacy);await read('window.dispatchEvent(new Event("focus"))');
  await until('document.getElementById("aiTaskStatus").dataset.status==="completed"');

  // Browsers without EventSource still get task details and completion snapshots.
  const noStream=fs.readFileSync(page,'utf8').replace('constructor(){window.fakeSource=this;queueMicrotask(()=>this.onopen?.());}',"constructor(){throw new Error('Streaming unavailable');}");
  fs.writeFileSync(page,noStream);await window.loadFile(page);
  await setSnapshot(snapshot(1,'completed','snapshot only'));
  await read('window.dispatchEvent(new Event("focus"))');
  await until('!document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden');
  await read('document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").click()');
  await until('document.querySelector("#aiTaskOutput pre")?.textContent==="snapshot only"');
  console.log(JSON.stringify({silentStreamRecovery:true,completionRecovered:true,duplicateDeltaIgnored:true,missingDeltaRecovered:true,stalePollIgnored:true,restartRecovered:true,legacyStreamingAfterPoll:true,noStreamingFallback:true}));
}
app.whenReady().then(run).catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  window?.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);
});
