// Real isolated renderer/backend acceptance. Only CLI output and input fixtures are synthetic.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const assert=require('node:assert/strict'),AdmZip=require('adm-zip');
const project=path.resolve(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-ui-edges-'));
const evidence=path.resolve(process.env.MEMO_ACCEPTANCE_OUT || path.join(__dirname,'acceptance-evidence/common'));
fs.mkdirSync(evidence,{recursive:true});app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const report={scope:'actual UI controls and isolated real HTTP/SQLite backend; simulated CLI output only for book generation',data:'fictional temporary database and synthetic ZIP fixtures only',startedAt:new Date().toISOString(),checks:[],notApplicable:[{name:'HEX 复制按钮 / Clipboard API',reason:'当前产品仅提供 HEX↔RGB 显示切换，没有复制按钮或 Clipboard API 调用；不新增功能，不列为未测。'}]};
let window,child,base,logs='';
const mode=path.join(root,'mode'),capture=path.join(root,'calls.jsonl'),dataDir=path.join(root,'data');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=async code=>{
  const result=await window.webContents.executeJavaScript(`(async()=>{try{const value=await (0,eval)(${JSON.stringify(code)});return {ok:true,value:typeof value==='function' ? null : value};}catch(error){return {ok:false,error:error.stack};}})()`);
  if(!result.ok)throw new Error(result.error);return result.value;
};
async function until(expression){for(let i=0;i<400;i++){if(await read(expression))return;await delay(25);}throw new Error('UI wait failed: '+expression);}
const click=id=>read(`document.getElementById(${JSON.stringify(id)}).click()`);
const fill=(id,value,event)=>read(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};${event ? `document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));` : ''}`);
const writeReport=()=>fs.writeFileSync(path.join(evidence,'ui-edges.json'),JSON.stringify(report,null,2));
async function screenshot(name){await delay(100);const file=name+'.png';fs.writeFileSync(path.join(evidence,file),(await window.webContents.capturePage()).toPNG());return file;}
async function check(id,name,simulation,action,shot=false){
  const item={id,name,method:'actual renderer controls + isolated real HTTP backend',simulation,status:'running'};report.checks.push(item);
  try{const details=await action();item.status='passed';if(details)item.details=details;if(shot)item.screenshot=await screenshot(id);}
  catch(error){item.status='failed';item.error=error.stack;item.screenshot=await screenshot(id+'-failed').catch(()=>null);}
  console.log(JSON.stringify(item));writeReport();
}
async function request(route){const response=await fetch(base+route);assert.ok(response.ok);return response.json();}
function calls(){return fs.existsSync(capture) ? fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];}
function zip(entries){const archive=new AdmZip();for(const [name,content]of entries)archive.addFile(name,Buffer.from(content));return archive.toBuffer().toString('base64');}
const validZip=zip([['reading/book.txt','每天阅读一点，观察生活，给植物浇水，与朋友分享阅读中的发现。以轻松的行动养成习惯。']]);
const emptyZip=zip([]),noTextZip=zip([['pictures/cover.png',Buffer.from([137,80,78,71,13,10,26,10])]]);
async function selectFile(name,bytes){
  return read(`(()=>{let pickerClicked=false;const field=document.getElementById('habitFileInput');field.addEventListener('click',event=>{event.preventDefault();pickerClicked=true;},{once:true});document.getElementById('habitUploadArea').click();if(!pickerClicked)throw new Error('Upload area did not invoke file input');const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'application/zip'}));field.files=transfer.files;field.dispatchEvent(new Event('change',{bubbles:true}));return {pickerClicked,selectedName:field.files[0].name};})()`);
}
async function dropFile(name,bytes){
  return read(`(()=>{const area=document.getElementById('habitUploadArea'),transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'application/zip'}));area.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));const highlighted=area.classList.contains('dragover');area.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return {highlighted,highlightCleared:!area.classList.contains('dragover')};})()`);
}
async function assertUploadRestored(expectedPools){
  await until(`!habitGenerating && !document.getElementById('habitUploadArea').classList.contains('hidden') && document.getElementById('habitUploadProgress').classList.contains('hidden') && document.getElementById('habitFileInput').value===''`);
  assert.equal(await read('document.getElementById("habitFileInput").value'),'');
  assert.equal((await request('/api/habit/pools')).pools.length,expectedPools);
  assert.equal((await request('/api/ai/status')).busy,false);assert.equal(await read('_ccTaskSet.size'),0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir,'habit_upload')),[]);
}
async function viewNewestPool(expectedPools){
  await until(`habitPools.length===${expectedPools}`);
  assert.equal((await request('/api/habit/pools')).pools.at(-1).habits.length,30);
  await read(`document.querySelectorAll('.habit-pool-info')[${expectedPools-1}].click()`);
  await until('document.querySelectorAll(".habit-pool-detail-item").length===30');
  assert.equal(await read('document.querySelectorAll(".habit-pool-detail-item").length'),30);
  await click('habitPoolDetailClose');
}
async function run(){
  const data=require('../storage/defaults')(),now=new Date().toISOString();
  data['settings.json'].agent='cc';data['settings.json'].tags=['隔离验收'];
  data['memos.json'].memos=[{id:'old',content:'甲计划：旧搜索结果',tags:['隔离验收'],createdAt:now},{id:'new',content:'乙计划：新搜索结果',tags:['隔离验收'],createdAt:now}];
  data['habit_pools.json'].pools=[];data['habit_log.json'].logs=[];data['scheduled_tasks.json'].tasks=[];
  fs.mkdirSync(dataDir);for(const [file,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const node=process.env.MEMO_TEST_NODE || process.execPath,fake=path.join(root,'fake-claude'),quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  fs.writeFileSync(fake,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  const missing=path.join(root,'intentionally-not-installed');
  child=spawn(node,[path.join(project,'server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',PORT:String(port),MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,CLAUDE_CLI:fake,CODEX_CLI:missing,TRAE_CLI:missing,CODEBUDDY_CLI:missing,MEMO_FAKE_CC_INVALID_FILE:mode,MEMO_FAKE_CC_CAPTURE:capture},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',chunk=>{logs+=chunk;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs));});});
  window=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error('[Renderer]',message);});
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(base+'/')}));
  await window.loadURL(base);await until('agentStatusKnown && aiState.configured && memos.length===2');
  await check('E01','快速搜索：真实旧响应延迟后不覆盖新查询', ['仅延迟旧搜索 fetch 返回时间；请求和响应内容均来自真实本机后端'],async()=>{
    await read(`window.originalFetch=window.fetch;window.searchTrace=[];window.oldSearchHeld=false;window.fetch=async function(input,options){const url=new URL(typeof input==='string' ? input : input.url,location.href);const response=await window.originalFetch.call(this,input,options);if(url.pathname==='/api/memos' && url.searchParams.has('keyword')){window.searchTrace.push({keyword:url.searchParams.get('keyword'),status:response.status,ids:(await response.clone().json()).map(m=>m.id)});if(url.searchParams.get('keyword')==='甲'){window.oldSearchHeld=true;await new Promise(resolve=>window.releaseOldSearch=resolve);}}return response;};`);
    await fill('searchInput','甲','input');await until('window.oldSearchHeld');
    await fill('searchInput','乙','input');await delay(30);await fill('searchInput','乙计划','input');
    await until('filteredMemos?.length===1 && filteredMemos[0].id==="new"');
    await read('window.releaseOldSearch()');await delay(250);
    assert.deepEqual(await read('filteredMemos.map(m=>m.id)'),['new']);assert.match(await read('document.getElementById("kanbanGrid").textContent'),/乙计划/);assert.doesNotMatch(await read('document.getElementById("kanbanGrid").textContent'),/甲计划/);
    const trace=await read('window.searchTrace');assert.deepEqual(trace.map(x=>x.keyword),['甲','乙计划']);assert.deepEqual(trace[0].ids,['old']);assert.deepEqual(trace[1].ids,['new']);
    await read('window.fetch=window.originalFetch');return {responseOrder:['new','old'],finalMemoIds:['new'],trace};
  },true);
  await check('E02','清空搜索后延迟旧响应不会重新筛选', ['仅延迟真实本机搜索响应返回时间'],async()=>{
    await read(`window.oldSearchHeld=false;window.fetch=async function(input,options){const response=await window.originalFetch.call(this,input,options);const url=new URL(typeof input==='string' ? input : input.url,location.href);if(url.pathname==='/api/memos' && url.searchParams.get('keyword')==='甲'){window.oldSearchHeld=true;await new Promise(resolve=>window.releaseOldSearch=resolve);}return response;};`);
    await fill('searchInput','甲','input');await until('window.oldSearchHeld');await click('searchClearBtn');await until('filteredMemos===null');
    await read('window.releaseOldSearch()');await delay(250);assert.equal(await read('filteredMemos'),null);assert.equal(await read('document.querySelectorAll(".memo-card").length'),2);await read('window.fetch=window.originalFetch');
  });
  await check('E03','六个自定义颜色 HEX↔RGB 切换及改色同步', [],async()=>{
    await click('settingsToggle');await click('customThemeBtn');const results=[];
    for(const id of ['ctBg','ctCard','ctAccent','ctText','ctBorder','ctDeco']){
      const original=await read(`document.getElementById('${id}').value`);
      await fill(id,'#123456','input');assert.equal(await read(`document.querySelector('.ct-hex[data-for=${id}]').textContent`),'#123456');
      await read(`document.querySelector('.ct-hex[data-for=${id}]').click()`);assert.equal(await read(`document.querySelector('.ct-hex[data-for=${id}]').textContent`),'18, 52, 86');
      await fill(id,'#abcdef','input');assert.equal(await read(`document.querySelector('.ct-hex[data-for=${id}]').textContent`),'171, 205, 239');
      await read(`document.querySelector('.ct-hex[data-for=${id}]').click()`);assert.equal(await read(`document.querySelector('.ct-hex[data-for=${id}]').textContent`),'#ABCDEF');results.push({id,hex:'#ABCDEF',rgb:'171, 205, 239'});await fill(id,original,'input');
    }
    await fill('ctAccent','#123456','input');await read(`document.querySelector('.ct-hex[data-for=ctAccent]').click()`);return {colors:results};
  },true);
  await click('ctApplyBtn');
  await click('btnHabitTrack');await until('habitPools.length===0');
  const fixtureSimulation=['合成书籍 ZIP；通过 DataTransfer 填充文件输入并派发真实 change 事件；原生文件选择器被 preventDefault，不打开系统对话框','使用 fake-model-cli.js 模拟 Claude Code 输出；上传 HTTP、ZIP 解压、SQLite 保存与 30 张卡片详情均为真实应用代码'];
  await check('E04','点击上传区选 ZIP → 生成进度 → 30 卡 → 查看',fixtureSimulation,async()=>{
    fs.writeFileSync(mode,'slow');const selection=await selectFile('selected-book.zip',validZip);await until('habitGenerating');assert.equal(await read('document.getElementById("habitUploadArea").classList.contains("hidden")'),true);assert.match(await read('document.getElementById("habitUploadProgress").textContent'),/正在总结习惯/);
    const progressScreenshot=await screenshot('E04-progress');await until('!habitGenerating && habitPools.length===1');await assertUploadRestored(1);await viewNewestPool(1);return {...selection,progressScreenshot,savedCards:30,detailCards:30,modelCalls:calls().length};
  },true);
  await check('E05','拖入 ZIP 高亮及释放 → 30 卡 → 查看', ['合成 ZIP 和 DragEvent/DataTransfer；模拟 CLI 输出；真实上传、解析、保存和详情'],async()=>{
    fs.writeFileSync(mode,'');const drag=await dropFile('dropped-book.zip',validZip);assert.deepEqual(drag,{highlighted:true,highlightCleared:true});await until('habitPools.length===2 && !habitGenerating');await assertUploadRestored(2);await viewNewestPool(2);return {...drag,savedCards:30,detailCards:30};
  },true);
  await check('E06','非 ZIP 文件在上传入口被拒绝', ['合成文件与 change 事件；不调用模型'],async()=>{
    const before=calls().length;await selectFile('wrong-format.txt',validZip);await until('document.getElementById("appToast").textContent.includes("请上传ZIP文件")');assert.equal(calls().length,before);assert.equal((await request('/api/habit/pools')).pools.length,2);assert.equal(await read('habitGenerating'),false);return {toast:await read('document.getElementById("appToast").textContent'),modelCallsAdded:0};
  });
  await check('E07','空 ZIP 失败提示及上传控件恢复', ['真实空 ZIP；DataTransfer 文件选择；未触发模拟模型'],async()=>{
    const before=calls().length;await selectFile('empty-book.zip',emptyZip);await until('document.getElementById("appToast").textContent.includes("没成功") || document.getElementById("appToast").textContent.includes("没有找到能读")');await assertUploadRestored(2);assert.equal(calls().length,before);return {toast:await read('document.getElementById("appToast").textContent'),modelCallsAdded:0};
  },true);
  await check('E08','无文本 ZIP 提示换书且不保存卡池', ['仅含 PNG 的合成 ZIP；真实上传后端；未触发模拟模型'],async()=>{
    const before=calls().length;await selectFile('pictures-only.zip',noTextZip);await until('document.getElementById("appToast").textContent.includes("没有找到能读")');await assertUploadRestored(2);assert.equal(calls().length,before);return {toast:await read('document.getElementById("appToast").textContent'),modelCallsAdded:0};
  },true);
  await check('E09','书籍模型失败提示、解锁及控件恢复', ['合成 ZIP；模拟 CLI 非零退出；其余上传链路真实'],async()=>{
    fs.writeFileSync(mode,'fail:habit-pool');const before=calls().length;await selectFile('model-failure.zip',validZip);await until('document.getElementById("appToast").textContent.includes("没成功")');await assertUploadRestored(2);assert.equal(calls().length,before+1);return {toast:await read('document.getElementById("appToast").textContent'),modelCallsAdded:1,partialPoolSaved:false};
  },true);
  await check('E10','失败后重新选有效 ZIP 可生成并查看 30 卡',fixtureSimulation,async()=>{
    fs.writeFileSync(mode,'');const before=calls().length;await selectFile('recovered-book.zip',validZip);await until('habitPools.length===3 && !habitGenerating');await assertUploadRestored(3);await viewNewestPool(3);assert.equal(calls().length,before+1);return {savedCards:30,detailCards:30,modelCallsAdded:1};
  },true);
  report.finishedAt=new Date().toISOString();report.passed=report.checks.filter(x=>x.status==='passed').length;report.failed=report.checks.filter(x=>x.status==='failed').length;
  report.modelCalls=calls().map(({task,argv})=>({task,argv}));fs.writeFileSync(path.join(evidence,'ui-edges-calls.json'),JSON.stringify(report.modelCalls,null,2));writeReport();console.log(JSON.stringify({uiEdgesAcceptance:true,passed:report.passed,failed:report.failed,report:path.join(evidence,'ui-edges.json')}));if(report.failed)process.exitCode=1;
}
app.whenReady().then(run).catch(error=>{report.fatalError=error.stack;process.exitCode=1;console.error(error.stack);}).finally(async()=>{
  writeReport();fs.writeFileSync(path.join(evidence,'ui-edges-server.log'),logs);window?.destroy();if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(process.exitCode || 0);
});
