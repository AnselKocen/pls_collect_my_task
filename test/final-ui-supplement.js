// Final-round UI gap checks. Isolated SQLite and deterministic simulated CC only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-final-ui-extra-'));
const evidence=path.resolve(process.env.MEMO_ACCEPTANCE_OUT || path.join(root,'evidence'));fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const report={startedAt:new Date().toISOString(),mode:'actual renderer and SQLite; simulated CC only',syntheticData:true,checks:[]};
let child,window,base,logs='',mode;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const read=code=>window.webContents.executeJavaScript(code);
async function until(code){const end=Date.now()+15000;while(Date.now()<end){if(await read(code))return;await delay(30);}throw new Error('UI wait failed: '+code);}
const click=id=>read(`document.getElementById(${JSON.stringify(id)}).click()`);
const fill=(id,value,event)=>read(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};${event?`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))`:''}`);
async function api(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
async function reload(){const loaded=once(window.webContents,'did-finish-load');window.reload();await loaded;await until('agentStatusKnown && aiState.configured && memos.length>0');if(process.env.MEMO_D3_TEST_FILE)await read(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));}
async function shot(name){const file=name+'.png';fs.writeFileSync(path.join(evidence,file),(await window.webContents.capturePage()).toPNG());return file;}
function save(){fs.writeFileSync(path.join(evidence,'supplement.json'),JSON.stringify(report,null,2));}
async function check(id,name,work){const row={id,name,status:'running',startedAt:new Date().toISOString()};report.checks.push(row);save();try{row.details=await work()||{};row.status='passed';}catch(error){row.status='failed';row.error=error.stack;row.screenshot=await shot(id+'-failed').catch(()=>null);}row.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(row));}
async function run(){
  const data=require('../storage/defaults')(),now=new Date().toISOString(),dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  data['settings.json'].agent='cc';data['settings.json'].tags=['甲','乙'];
  data['memos.json'].memos=[{id:'note-a',content:'阅读与休息的虚构记录',tags:['甲'],createdAt:now},{id:'note-b',content:'整理书桌的虚构记录',tags:['乙'],createdAt:now}];
  data['habit_pools.json'].pools=[{id:'pool-a',name:'甲池',habits:['甲池唯一动作']},{id:'pool-b',name:'乙池',habits:['乙池唯一动作']}];
  data['habit_log.json'].logs=[];data['ai_suggestions.json']={graphHistory:[],tagSummaries:[],tagSuggestionHistory:[],weeklyDigests:[]};
  for(const [file,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const node=process.env.MEMO_TEST_NODE||process.execPath,fake=path.join(root,'fake-cc'),quote=v=>"'"+v.replace(/'/g,"'\\''")+"'";mode=path.join(root,'mode');
  fs.writeFileSync(fake,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
  child=spawn(node,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,PORT:String(port),CLAUDE_CLI:fake,MEMO_FAKE_CC_INVALID_FILE:mode},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Startup timeout: '+logs)),10000);child.stdout.on('data',d=>{logs+=d;if(logs.includes('Memo server running')){clearTimeout(timeout);resolve();}});child.stderr.on('data',d=>{logs+=d;});child.once('exit',c=>{clearTimeout(timeout);reject(new Error('Startup '+c+': '+logs));});});
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(detail,callback)=>callback({cancel:!detail.url.startsWith(base+'/')}));
  await window.loadURL(base);await until('agentStatusKnown && aiState.configured && memos.length===2');
  if(process.env.MEMO_D3_TEST_FILE)await read(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
  let multilineId;
  await check('S01','多标签中文 emoji 换行和特殊字符新增',async()=>{
    const content='虚构补测 🌿 第一行\n第二行 <>& "引号"';await fill('memoInput',content);
    await read(`document.querySelectorAll('#tagSelector [data-tag]').forEach(el=>el.click())`);await click('sendBtn');await until('memos.length===3');
    const added=(await api('/api/memos')).body.find(m=>m.content===content);assert.ok(added);assert.deepEqual(added.tags,['甲','乙']);multilineId=added.id;
    const rendered=await read(`document.querySelector('.memo-card[data-id=${JSON.stringify(added.id)}] .memo-card-content').textContent`);assert.equal(rendered,content);return {id:added.id,content,tags:added.tags};
  });
  await check('S02','长便签详情保留全文与特殊字符',async()=>{
    const content=('长内容 🌿 <>&\n').repeat(600);const row=(await api('/api/memos','POST',{content,tags:['甲']})).body;await reload();
    await read(`document.querySelector('.memo-card[data-id=${JSON.stringify(row.id)}] .memo-card-content').click()`);await until('!document.getElementById("memoDetailModal").classList.contains("hidden")');
    assert.equal(await read('document.getElementById("memoDetailContent").textContent'),content);await click('memoDetailClose');await api('/api/memos/'+row.id,'DELETE');return {characters:content.length};
  });
  await check('S03','置顶排序刷新后保留',async()=>{
    await read(`document.querySelector('.memo-card[data-id=${JSON.stringify(multilineId)}] .pin-btn').click()`);await until(`memos.find(m=>m.id===${JSON.stringify(multilineId)})?.pinned===true`);await reload();
    assert.equal(await read('memos[0].id'),multilineId);await read(`document.querySelector('.memo-card[data-id=${JSON.stringify(multilineId)}] .pin-btn').click()`);await until(`!memos.find(m=>m.id===${JSON.stringify(multilineId)})?.pinned`);return {refreshPreserved:true};
  });
  await check('S04','空标签和重命名冲突不改原数据',async()=>{
    await click('tagManagerBtn');await fill('newTagName','   ');await click('addNewTagBtn');await delay(100);assert.deepEqual((await api('/api/tags')).body,['甲','乙']);
    await read(`window.__renameOriginalFetch=window.fetch;window.__renameResult=null;window.fetch=async function(input,options){const response=await __renameOriginalFetch.call(this,input,options);if(String(input).includes('/api/tags/') && options?.method==='PUT'){window.__renameResult={status:response.status,body:await response.clone().json()};}return response;};document.querySelector('.tag-edit[data-tag="甲"]').click();var input=document.querySelector('.tag-edit-name-input');input.value='乙';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.tag-edit-confirm').click()`);
    await until('window.__renameResult?.status===409');assert.deepEqual((await api('/api/tags')).body,['甲','乙']);assert.ok((await api('/api/memos')).body.some(m=>m.tags.includes('甲')));
    await read(`window.fetch=window.__renameOriginalFetch;document.querySelector('.tag-edit-cancel').click()`);await click('tagManagerClose');return {emptyRejected:true,conflictRollback:true,responseStatus:409};
  });
  await check('S05','卡池空名称与空卡片拒绝并保留原值',async()=>{
    await click('btnHabitTrack');await until('habitPools.length===2');await read(`document.querySelector('.habit-pool-info').click()`);await fill('habitPoolDetailNameInput','  ');await click('habitPoolDetailNameSave');
    await until('document.getElementById("appToast").textContent.includes("名字")');assert.equal((await api('/api/habit/pools')).body.pools[0].name,'甲池');
    await read(`document.querySelector('.habit-pool-detail-edit').click();var input=document.querySelector('.habit-pool-detail-input');input.value='   ';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);await delay(100);
    assert.deepEqual((await api('/api/habit/pools')).body.pools[0].habits,['甲池唯一动作']);await click('habitPoolDetailClose');return {emptyFieldsRejected:true};
  });
  await check('S06','多个可用卡池切换分别抽取且重复完成不新增',async()=>{
    await read(`document.querySelector('.habit-tab[data-tab="draw"]').click()`);await until('document.querySelectorAll(".habit-draw-pool-chip").length===2');
    for(const pool of ['pool-a','pool-b']){
      await read(`document.querySelector('.habit-draw-pool-chip[data-id="${pool}"]').click()`);await click('habitDrawBtn');await until(`!document.getElementById('habitDrawResult').classList.contains('hidden')`);
      const logs=(await api('/api/habit/today')).body.logs;assert.equal(logs.at(-1).poolId,pool);assert.equal(logs.at(-1).habit,pool==='pool-a'?'甲池唯一动作':'乙池唯一动作');await click('habitDrawBack');
    }
    const log=(await api('/api/habit/today')).body.logs[0];await api('/api/habit/log/'+log.id+'/complete','PUT',{});await api('/api/habit/log/'+log.id+'/complete','PUT',{});const after=(await api('/api/habit/today')).body.logs;assert.equal(after.length,2);assert.equal(after.filter(l=>l.completed).length,1);await click('tagSummaryClose');return {switchedPools:2,logs:2,repeatedCompleteAdds:0};
  });
  await check('S07','全部六种自定义颜色保存并刷新保持',async()=>{
    await click('customThemeBtn');const values={ctBg:'#f1e2d3',ctCard:'#ffffff',ctAccent:'#456789',ctText:'#223344',ctBorder:'#bbccdd',ctDeco:'#aabbcc'};
    for(const [id,value]of Object.entries(values))await fill(id,value,'input');await click('ctApplyBtn');await until('settings.theme==="custom"');await reload();
    assert.deepEqual((await api('/api/settings')).body.customColors,{bg:'#f1e2d3',card:'#ffffff',accent:'#456789',text:'#223344',border:'#bbccdd',deco:'#aabbcc'});return {colors:6,refreshPreserved:true};
  });
  await check('S08','CC 模拟从按钮生成摘要并折叠展开',async()=>{
    await click('digestRegenBtn');await until('document.getElementById("digestRegenBtn").disabled');await until('!document.getElementById("digestRegenBtn").disabled');await until('document.getElementById("digestText").textContent.length>0');
    assert.ok((await api('/api/cc/suggestions')).body.dailyDigest?.summary);const before=await read('document.getElementById("digestBanner").classList.contains("digest-collapsed")');await click('digestToggle');assert.equal(await read('document.getElementById("digestBanner").classList.contains("digest-collapsed")'),!before);await click('digestToggle');return {agent:'cc',simulated:true};
  });
  await check('S09','CC 模拟单标签周总结展示历史与删除',async()=>{
    await click('btnWeeklyDigest');await until('!document.getElementById("weeklyModal").classList.contains("hidden") && !!document.querySelector("#weeklyTagPicker [data-tag]")');await read(`document.querySelector('#weeklyTagPicker [data-tag="甲"]').click()`);await click('weeklyGenBtn');await until('!document.getElementById("weeklyGenBtn").disabled && weeklyHistory.length===1');
    assert.deepEqual((await api('/api/cc/suggestions')).body.weeklyDigests[0].tags,['甲']);await read(`document.querySelector('#weeklyHistory .summary-item-actions button').click()`);assert.equal(await read('document.querySelector("#weeklyHistory .tag-summary-item-content").classList.contains("collapsed-content")'),false);
    await click('weeklyClose');await click('btnWeeklyDigest');await until('!document.getElementById("weeklyModal").classList.contains("hidden")');assert.equal(await read('document.querySelectorAll("#weeklyHistory .tag-summary-item").length'),1);await read(`document.querySelector('#weeklyHistory .delete-btn').click()`);await click('confirmOk');await until('weeklyHistory.length===0');await click('weeklyClose');return {agent:'cc',simulated:true,tags:['甲'],historyDeleted:true};
  });
  await check('S10','CC 模拟标签建议真实控件与增量历史',async()=>{
    fs.writeFileSync(mode,'stream-slow');await click('btnTagSuggest');await until('!document.getElementById("tagSuggestModal").classList.contains("hidden")');await click('tagSuggestGenBtn');await until('aiState.busy');await click('aiTaskDetailsBtn');await until('document.querySelector("#aiTaskOutput pre")?.textContent.length>0');
    const first=await read('document.querySelector("#aiTaskOutput pre").textContent.length');await until(`document.querySelector('#aiTaskOutput pre')?.textContent.length>${first}`);await until('!document.getElementById("tagSuggestGenBtn").disabled && tagSuggestHistory.length===1');await click('aiTaskClose');
    await read(`document.querySelector('#tagSuggestHistory .summary-item-actions button').click()`);await read(`document.querySelector('#tagSuggestHistory .delete-btn').click()`);await click('confirmOk');await until('tagSuggestHistory.length===0');await click('tagSuggestClose');fs.rmSync(mode);return {agent:'cc',simulated:true,incrementObserved:true,historyDeleted:true};
  });
  await check('S11','CC 模拟图谱从实际按钮生成展示',async()=>{
    await click('btnTagGraph');await click('graphRegenBtn');await until('!document.getElementById("graphRegenBtn").disabled && graphHistory.length===1');await until('document.querySelectorAll("#graphContainer .graph-node").length>0');const nodes=await read('document.querySelectorAll("#graphContainer .graph-node").length');await shot('cc-graph');await click('graphClose');return {agent:'cc',simulated:true,nodes};
  });
  await check('S12','便签编辑中特殊内容不被执行',async()=>{
    const content='</textarea><img data-probe="memo-xss" src="invalid-probe" onerror="window.__memoProbe=1"><textarea>文本';const memo=(await api('/api/memos','POST',{content,tags:['甲']})).body;await reload();
    await read(`window.__memoProbe=0;document.querySelector('.memo-card[data-id=${JSON.stringify(memo.id)}] button[title="编辑"]').click()`);await delay(150);
    const probe=await read(`({executed:window.__memoProbe,injected:!!document.querySelector('[data-probe="memo-xss"]'),value:document.querySelector('.memo-card[data-id=${JSON.stringify(memo.id)}] textarea')?.value})`);
    await shot('memo-editor-escaping');report.securityProbe=probe;save();assert.equal(probe.executed,0,'User text executed an onerror handler');assert.equal(probe.injected,false,'User text created an HTML element in the editor');assert.equal(probe.value,content);return probe;
  });
  report.finishedAt=new Date().toISOString();report.passed=report.checks.filter(c=>c.status==='passed').length;report.failed=report.checks.filter(c=>c.status==='failed').length;save();if(report.failed)process.exitCode=1;
}
app.whenReady().then(run).catch(error=>{report.fatalError=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{save();fs.writeFileSync(path.join(evidence,'server.log'),logs);window?.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});console.log(JSON.stringify({supplement:true,passed:report.passed,failed:report.failed}));app.exit(process.exitCode||0);});
