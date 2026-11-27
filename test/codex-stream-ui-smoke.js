// Manual real-Codex UI test. The server and browser contain fictional records only.
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),assert=require('assert/strict');
const {spawn}=require('child_process'),{once}=require('events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-codex-ui-live-'));
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
let child,window,logs='';
const delay=ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(expression,timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(await window.webContents.executeJavaScript(expression))return;
    if(expression.includes('_ccLatestTask') && await window.webContents.executeJavaScript('window._ccLatestTask?.status==="failed"'))throw new Error('AI task failed before text: '+logs);
    await delay(50);
  }
  throw new Error('Live UI wait timed out: '+expression);
}
async function run() {
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  const fixture=require('../storage/defaults')();
  const pairs=[['reading','books'],['fitness','exercise'],['cooking','recipes'],['music','songs'],['travel','trips'],['coding','programming'],['films','movies'],['gardening','plants']];
  fixture['settings.json'].agent='codex';fixture['settings.json'].tags=pairs.flat();
  fixture['memos.json'].memos=pairs.map((tags,index)=>({id:'fictional-'+(index+1),content:'Fictional integration-test record about '+tags.join(' and ')+'. Both labels describe the same activity.',tags,createdAt:new Date().toISOString()}));
  for(const [file,value] of Object.entries(fixture))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve => probe.close(resolve));
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',chunk => {logs+=chunk;});
  await new Promise((resolve,reject) => {
    const timer=setTimeout(() => reject(new Error('Server startup failed: '+logs)),10000);
    child.stdout.on('data',chunk => {logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});
    child.once('exit',code => {clearTimeout(timer);reject(new Error('Server exited '+code));});
  });
  window=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback) => callback({cancel:!details.url.startsWith(`http://127.0.0.1:${port}/`) || details.url.endsWith('/api/ai/task')}));
  await window.loadURL(`http://127.0.0.1:${port}/`);
  await until('agentStatusKnown && settings.agent==="codex" && !document.getElementById("agentSelect").disabled');
  await window.webContents.executeJavaScript('document.getElementById("btnTagSuggest").click()');
  await until('!document.getElementById("tagSuggestModal").classList.contains("hidden")');
  await window.webContents.executeJavaScript(`
    window.streamSamples=[];window.streamStart=performance.now();
    window.streamListener=event=>{
      const task=event.detail.task,chars=(task?.messages || []).reduce((n,message)=>n+message.text.length,0);
      if(task?.status==='running' && chars>(window.streamSamples.at(-1)?.chars || 0)) {
        window.streamSamples.push({ms:Math.round(performance.now()-window.streamStart),chars});
      }
    };
    window.addEventListener('cc-task-update',window.streamListener);
  `);
  const started=Date.now();
  await window.webContents.executeJavaScript('document.getElementById("tagSuggestGenBtn").click()');
  await until('window._ccLatestTask?.status==="running" && _ccLatestTask.messages.some(m=>m.text.length>0)',290000);
  const partial=await window.webContents.executeJavaScript(`(async()=>{
    const output=_ccLatestTask.messages.map(m=>m.text).join('');
    const running=_ccLatestTask.status==='running';
    document.getElementById('tagSuggestClose').click();
    const locked=document.getElementById('agentSelect').disabled;
    const blocked=!(await window.openAITaskDestination());
    return {running,locked,blocked,buttonHidden:document.querySelector('#tagSuggestGenBtn + [data-ai-task-details]').hidden,preserved:_ccLatestTask.messages.map(m=>m.text).join('').startsWith(output),noTranscript:!document.getElementById('aiTaskModal')};
  })()`);
  assert.ok(partial.running,'Text must arrive before completion');assert.ok(partial.locked);assert.ok(partial.blocked);assert.ok(partial.buttonHidden);assert.ok(partial.preserved);assert.ok(partial.noTranscript);
  console.log(JSON.stringify({realCodexTaskNavigation:true,firstReplyMs:Date.now()-started,...partial}));
  await until('window._ccLatestTask?.status==="completed" && !document.getElementById("tagSuggestGenBtn").disabled',60000);
  await until('!document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").hidden');
  await window.webContents.executeJavaScript('document.querySelector("#tagSuggestGenBtn + [data-ai-task-details]").click()');
  await until('!document.getElementById("tagSuggestModal").classList.contains("hidden")');
  const endState=await window.webContents.executeJavaScript('({history:tagSuggestHistory.length,locked:document.getElementById("agentSelect").disabled,output:_ccLatestTask.messages.at(-1).text})');
  assert.equal(endState.history,1);assert.equal(endState.locked,false);assert.ok(Array.isArray(JSON.parse(endState.output)));
  const samples=await window.webContents.executeJavaScript('window.streamSamples');
  assert.ok(samples.length>=3,'Expected three or more retained text increases before completion, with polling blocked: '+JSON.stringify(samples));
  console.log(JSON.stringify({realCodexRetainedGrowth:true,snapshotPollingBlocked:true,samples:samples.length,first:samples[0],middle:samples[Math.floor(samples.length/2)],last:samples.at(-1)}));
  const out=process.env.MEMO_UI_SCREENSHOT_DIR;
  if(out){await delay(150);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'codex-stream-completed.png'),(await window.webContents.capturePage()).toPNG());}
  console.log(JSON.stringify({realCodexStreamUI:true,elapsedMs:Date.now()-started,validatedAndSaved:true}));
}
app.whenReady().then(run).catch(error => {console.error(error.stack);process.exitCode=1;}).finally(async () => {
  window?.destroy();if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode || 0);
});
