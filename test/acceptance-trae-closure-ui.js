// Product-entry closure regression. Isolated legacy Trae settings; synthetic CLI only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const assert=require('node:assert/strict'),AdmZip=require('adm-zip');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-trae-closure-ui-'));
const evidence=path.join(__dirname,'acceptance-evidence/trae-closure');fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const report={scope:'current product UI: Trae entry closed; adapter and historical data retained',data:'fictional isolated legacy settings.agent=trae and temporary SQLite database only',simulation:['synthetic CLI executables for all four adapters; one simulated Codex task; no real model/account calls','controlled renderer state injection only for stale-option fallback check'],startedAt:new Date().toISOString(),checks:[]};
let window,child,base,logs='';
const capture=path.join(root,'calls.jsonl'),mode=path.join(root,'mode'),dataDir=path.join(root,'data'),paths={};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=async code=>{const result=await window.webContents.executeJavaScript(`(async()=>{try{const value=await (0,eval)(${JSON.stringify(code)});return {ok:true,value:typeof value==='function' ? null : value};}catch(error){return {ok:false,error:error.stack};}})()`);if(!result.ok)throw new Error(result.error);return result.value;};
async function until(expression){for(let i=0;i<400;i++){if(await read(expression))return;await delay(25);}throw new Error('UI wait failed: '+expression);}
async function shot(name){await delay(100);const file=name+'.png';fs.writeFileSync(path.join(evidence,file),(await window.webContents.capturePage()).toPNG());return file;}
const save=()=>fs.writeFileSync(path.join(evidence,'ui.json'),JSON.stringify(report,null,2));
async function check(id,name,action,screenshot=false){const item={id,name,method:'actual renderer and real isolated HTTP/SQLite backend',status:'running'};report.checks.push(item);try{const details=await action();item.status='passed';if(details)item.details=details;if(screenshot)item.screenshot=await shot(id);}catch(error){item.status='failed';item.error=error.stack;item.screenshot=await shot(id+'-failed').catch(()=>null);}console.log(JSON.stringify(item));save();}
async function api(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Memo-AI':'1'},...(body ? {body:JSON.stringify(body)} : {})});return {status:response.status,body:await response.json()};}
async function exportRawSettings(){const response=await fetch(base+'/api/storage/export');assert.ok(response.ok);return JSON.parse(new AdmZip(Buffer.from(await response.arrayBuffer())).readAsText('settings.json'));}
async function run(){
  const data=require('../storage/defaults')();data['settings.json'].agent='trae';data['memos.json'].memos=[{id:'closure-fixture',content:'关闭入口验收：今天读了两页书。',tags:['欢迎'],createdAt:new Date().toISOString()}];data['habit_pools.json'].pools=[];data['scheduled_tasks.json'].tasks=[];
  fs.mkdirSync(dataDir);for(const [name,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const node=process.env.MEMO_TEST_NODE || process.execPath,quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  for(const id of ['cc','codex','codebuddy','trae']){paths[id]=path.join(root,'fake-'+id);fs.writeFileSync(paths[id],`#!/bin/sh\nMEMO_FAKE_AGENT=${quote(id)} exec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});}
  fs.writeFileSync(path.join(root,'ai-config.json'),JSON.stringify({paths:{trae:paths.trae}}));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  child=spawn(node,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',PORT:String(port),MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,CLAUDE_CLI:paths.cc,CODEX_CLI:paths.codex,CODEBUDDY_CLI:paths.codebuddy,TRAE_CLI:paths.trae,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_INVALID_FILE:mode},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',chunk=>{logs+=chunk;});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs));});});
  window=new BrowserWindow({show:false,width:1250,height:850,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(base+'/')}));
  await window.loadURL(base);await until('agentStatusKnown && !document.getElementById("agentSelect").disabled');await read('document.getElementById("settingsSection").classList.remove("section-collapsed")');
  await check('TC01','旧 Trae 配置启动后仅三个选项，回退 Codex 且非空',async()=>{
    const options=await read('[...document.getElementById("agentSelect").options].map(option=>option.value)');assert.deepEqual(options,['cc','codex','codebuddy']);assert.equal(await read('document.querySelector("#agentSelect option[value=trae]")'),null);assert.equal(await read('document.getElementById("agentSelect").value'),'codex');
    const settings=await api('/api/settings'),status=await api('/api/ai/status');assert.equal(settings.body.agent,'codex');assert.equal(status.body.agent,'codex');assert.equal(status.body.configured,true);assert.equal((await exportRawSettings()).agent,'trae');return {options,effective:'codex',rawHistory:'trae'};
  },true);
  await check('TC02','只改主题仍返回有效助手，保留历史 Trae 配置',async()=>{
    await read('document.getElementById("themeSelect").value="mint";document.getElementById("themeSelect").dispatchEvent(new Event("change",{bubbles:true}))');await until('settings.theme==="mint"');assert.equal(await read('settings.agent'),'codex');assert.equal(await read('document.getElementById("agentSelect").value'),'codex');const raw=await exportRawSettings();assert.equal(raw.agent,'trae');assert.equal(raw.theme,'mint');return {effective:'codex',rawHistory:'trae',theme:'mint'};
  });
  await check('TC03','API 拒绝重新选择或配置 Trae，GET 保持有效值',async()=>{
    const denied=await api('/api/settings','PUT',{agent:'trae'});assert.equal(denied.status,400);assert.match(denied.body.error,/AGENT_DISABLED:trae/);const setup=await api('/api/ai/path','POST',{agent:'trae',path:paths.trae});assert.ok(setup.status>=400);assert.equal((await api('/api/settings')).body.agent,'codex');assert.equal((await api('/api/ai/status')).body.agent,'codex');assert.equal((await exportRawSettings()).agent,'trae');return {putStatus:denied.status,putError:denied.body.error,pathStatus:setup.status,getAgent:'codex'};
  });
  await check('TC04','历史 Trae 的任务使用 Codex；忙碌时同值允许、其他值拒绝',async()=>{
    fs.writeFileSync(mode,'slow');const pending=api('/api/cc/ask','POST',{action:'daily-digest'});
    for(let i=0;i<100;i++){if((await api('/api/ai/status')).body.busy)break;await delay(15);}
    assert.equal((await api('/api/ai/status')).body.busy,true);
    const same=await api('/api/settings','PUT',{agent:'codex'});assert.equal(same.status,200);assert.equal(same.body.agent,'codex');const other=await api('/api/settings','PUT',{agent:'cc'});assert.equal(other.status,409);const result=await pending;assert.equal(result.status,200);assert.equal((await api('/api/ai/status')).body.busy,false);fs.writeFileSync(mode,'');
    const calls=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.equal(calls[0].agent,'codex');assert.ok(calls[0].argv.includes('app-server'));assert.equal(calls.some(call=>call.agent==='trae'),false);return {sameEffectiveStatus:same.status,differentAgentStatus:other.status,taskAgent:calls[0].agent,traeModelCalls:0};
  });
  await check('TC05','三个有效助手均可通过界面切换并在刷新后保留',async()=>{
    const selected=[];for(const id of ['cc','codex','codebuddy']){
      await until('!document.getElementById("agentSelect").disabled');await read(`document.getElementById('agentSelect').value=${JSON.stringify(id)};document.getElementById('agentSelect').dispatchEvent(new Event('change',{bubbles:true}))`);await until(`settings.agent===${JSON.stringify(id)} && !agentSwitchPending && !document.getElementById('agentSelect').disabled`);assert.equal((await api('/api/settings')).body.agent,id);assert.equal((await api('/api/ai/status')).body.agent,id);selected.push(id);
    }
    const loaded=once(window.webContents,'did-finish-load');window.reload();await loaded;await until('agentStatusKnown && !document.getElementById("agentSelect").disabled');assert.equal(await read('document.getElementById("agentSelect").value'),'codebuddy');await read('document.getElementById("settingsSection").classList.remove("section-collapsed")');return {selected,reloadSelected:'codebuddy'};
  },true);
  await check('TC06','前端旧状态含 Trae 时选择器仍有有效值',async()=>{
    const original=await read('settings.agent'),active=await read('aiState.agent');assert.equal(active,'codebuddy');await read('settings.agent="trae";renderAgentControl()');const value=await read('document.getElementById("agentSelect").value');assert.equal(value,active);await read(`settings.agent=${JSON.stringify(original)};renderAgentControl()`);return {injectedState:'trae',activeAgent:active,displayed:value,simulation:'renderer stale-state injection only'};
  });
  await check('TC07','Trae 适配器和历史路径保留，可选名单严格为三个助手',async()=>{
    const agents=require('../agents'),protocol=require('../agents/stream-protocol');assert.deepEqual(agents.SELECTABLE_AGENTS,['cc','codex','codebuddy']);assert.equal(agents.getAgent('trae').command,'traecli');assert.equal(typeof protocol.createAcpSession,'function');assert.throws(()=>agents.getSelectableAgent('trae'),/AGENT_DISABLED:trae/);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'ai-config.json'),'utf8')).paths.trae,paths.trae);
    const missing=path.join(root,'missing'),env={...process.env,CLAUDE_CLI:paths.cc,CODEX_CLI:paths.codex,CODEBUDDY_CLI:paths.codebuddy};const fallbacks=[];
    for(const [codex,codebuddy,cc]of [[paths.codex,paths.codebuddy,paths.cc],[missing,paths.codebuddy,paths.cc],[missing,missing,paths.cc],[missing,missing,missing]])fallbacks.push(agents.resolveSelectableAgent('trae',{configDir:root,env:{...env,CODEX_CLI:codex,CODEBUDDY_CLI:codebuddy,CLAUDE_CLI:cc}}));assert.deepEqual(fallbacks,['codex','codebuddy','cc','cc']);return {selectable:agents.SELECTABLE_AGENTS,adapterRetained:true,acpRetained:true,savedTraePathRetained:true,fallbacks};
  });
  report.finishedAt=new Date().toISOString();report.passed=report.checks.filter(item=>item.status==='passed').length;report.failed=report.checks.filter(item=>item.status==='failed').length;save();console.log(JSON.stringify({traeClosureUi:true,passed:report.passed,failed:report.failed}));if(report.failed)process.exitCode=1;
}
app.whenReady().then(run).catch(error=>{report.fatalError=error.stack;process.exitCode=1;console.error(error.stack);}).finally(async()=>{save();fs.writeFileSync(path.join(evidence,'ui-server.log'),logs);window?.destroy();if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(process.exitCode || 0);});
