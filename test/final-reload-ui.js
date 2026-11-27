// A real page reload during generation. CC alone uses the deterministic CLI.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),assert=require('node:assert/strict');
const {getSelectableAgent,resolveCli}=require('../agents');
const agent=process.env.MEMO_TEST_AGENT,info=getSelectableAgent(agent),root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-final-reload-'+agent+'-'));
const out=path.resolve(process.env.MEMO_ACCEPTANCE_OUT);fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const report={agent,startedAt:new Date().toISOString(),realCli:agent!=='cc',mode:agent==='cc'?'simulation':'real',checks:[]};let child,window,base,logs='';const cleanups=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=code=>window.webContents.executeJavaScript(code);
async function until(expression,timeout=300000){const end=Date.now()+timeout;while(Date.now()<end){if(await read(expression))return;await pause(40);}throw new Error('Wait '+expression);}
async function snapshot(){return (await (await fetch(base+'/api/ai/task')).json()).task;}
async function run(){
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);const data=require('../storage/defaults')();data['settings.json'].agent=agent;data['habit_pools.json'].pools=[];data['settings.json'].tags=['reading','books'];data['ai_suggestions.json'].tagSuggestionHistory=[];
  data['memos.json'].memos=Array.from({length:8},(_,i)=>({id:'fictional-reload-'+i,content:'Fictional test record: reading books for five minutes and writing a note.',tags:['reading','books'],createdAt:new Date().toISOString()}));
  for(const [name,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  let env={...process.env};if(agent==='cc'){const fixture=require('./agent-fixture').fixture({after:fn=>cleanups.push(fn)});env={...env,...fixture.env};fs.writeFileSync(fixture.mode,process.env.MEMO_WAIT_PROBE?'slow':'stream-slow');}else for(const key of Object.keys(env))if(key.startsWith('MEMO_FAKE_'))delete env[key];
  const cli=resolveCli(agent,{env,configDir:root});assert.ok(cli);report.cli=cli;
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  child=spawn(process.env.MEMO_TEST_NODE || process.execPath,[path.join(__dirname,'../server.js')],{env:{...env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,[info.env]:cli,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),15000);child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.stderr.on('data',chunk=>{logs+=chunk;});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup '+code));});});
  window=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(request,callback)=>callback({cancel:!request.url.startsWith(base+'/')}));
  await window.loadURL(base+'/');await until('agentStatusKnown && aiState.configured');await read(`document.getElementById('btnTagSuggest').click();document.getElementById('tagSuggestGenBtn').click()`);await until('aiState.busy');await read(`window.openAITaskDetails()`);
  if(process.env.MEMO_WAIT_PROBE){
    await until(`document.getElementById('aiTaskStatus').dataset.status==='running' && /已用 0:0[1-2]/.test(document.getElementById('aiTaskMeta').textContent) && !document.querySelector('#aiTaskOutput pre')`);
    report.waiting=await read(`({stage:document.getElementById('aiTaskStage').textContent,meta:document.getElementById('aiTaskMeta').textContent,empty:document.querySelector('#aiTaskOutput .ai-task-empty').textContent})`);
    assert.ok(report.waiting.stage);assert.match(report.waiting.empty,/等待回答/);fs.writeFileSync(path.join(out,'waiting-before-first-text.png'),(await window.webContents.capturePage()).toPNG());
    await until(`document.getElementById('aiTaskStatus').dataset.status==='completed'`);report.checks=[{id:'AI27',status:'passed'}];report.success=true;return;
  }
  await until(`document.getElementById('aiTaskStatus').dataset.status==='running' && document.querySelector('#aiTaskOutput pre')?.textContent.length>0`);
  const before=await snapshot();assert.equal(before.status,'running');assert.ok(before.messages[0].text);report.before={id:before.id,status:before.status,chars:before.messages[0].text.length};
  await read(`document.getElementById('aiTaskClose').click();window.openAITaskDetails()`);await until(`!document.getElementById('aiTaskModal').classList.contains('hidden')`);assert.ok(await read(`document.querySelector('#aiTaskOutput pre').textContent.startsWith(${JSON.stringify(before.messages[0].text)})`));report.closeReopenPreserved=true;
  const loaded=once(window.webContents,'did-finish-load');window.reload();await loaded;await until('agentStatusKnown && !!window._ccLatestTask');await read('window.openAITaskDetails()');
  await until(`!![...document.querySelectorAll('#aiTaskOutput pre')].find(node=>node.textContent.startsWith(${JSON.stringify(before.messages[0].text)}))`);
  const after=await snapshot();assert.equal(after.id,before.id);report.after={id:after.id,status:after.status,chars:after.messages[0].text.length};
  await until(`document.getElementById('aiTaskStatus').dataset.status==='completed' && !document.getElementById('agentSelect').disabled`);
  const saved=await (await fetch(base+'/api/cc/suggestions')).json();assert.equal(saved.tagSuggestionHistory.length,1);report.savedHistory=1;
  fs.writeFileSync(path.join(out,'reload-completed.png'),(await window.webContents.capturePage()).toPNG());report.checks=[{id:'AI32',status:'passed'},{id:'AI31',status:'passed'}];report.success=true;
}
app.whenReady().then(run).catch(error=>{report.error=error.stack;report.success=false;report.checks.push({id:'AI32',status:'failed',detail:error.message});console.error(error.stack);}).finally(async()=>{window?.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'reload-ui.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(out,'server.log'),logs);for(const cleanup of cleanups)cleanup();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(report));app.exit(report.success?0:1);});
