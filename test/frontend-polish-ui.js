// Isolated UI regression: real local search + real D3, with a synthetic graph.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-frontend-polish-'));
const out=process.env.MEMO_POLISH_UI_DIR || path.join(root,'evidence');
const report={checks:[],rendererErrors:[],modelCalls:0};
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
let child,win,logs='';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<200;i++){if(await read(code))return;await delay(30);}throw new Error('UI timeout: '+code);}
async function shot(name){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function run(){
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  const seed=require('../storage/defaults')(),now=new Date().toISOString();
  seed['settings.json'].theme='mintchoc';
  seed['settings.json'].tags=['mark','待办','脑洞','链接','杂乱','账号','备份','tips','阅读','创作','生活','习惯','计划','灵感'];
  seed['settings.json'].tagOrder=[...seed['settings.json'].tags];
  seed['memos.json'].memos=[
    {id:'a',content:'每天读一点书，出门观察树叶。',tags:['阅读'],createdAt:now,updatedAt:now},
    {id:'b',content:'今天画了一只小猫。',tags:['创作'],createdAt:now,updatedAt:now}
  ];
  for(const [name,value]of Object.entries(seed))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  child=spawn(process.env.MEMO_TEST_NODE || process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,MEMO_ELECTRON:'1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stderr.on('data',x=>logs+=x);child.stdout.on('data',x=>{logs+=x;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code+logs));});});
  win=new BrowserWindow({show:false,width:1280,height:950,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)report.rendererErrors.push(message);});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{
    if(details.method==='POST' && /\/api\/(cc\/ask|habit\/wish|habit\/pools\/generate)/.test(details.url))report.modelCalls++;
    callback({cancel:!details.url.startsWith(`http://127.0.0.1:${port}/`)});
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
  // Focus emulation needs a loaded renderer; the hidden window has no OS focus.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await read(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
  await until('agentStatusKnown && memos.length===2');
  const settingsState=()=>read(`(()=>{const visible=id=>document.getElementById(id).getClientRects().length>0;return {collapsed:document.getElementById('settingsSection').classList.contains('section-collapsed'),expanded:document.getElementById('settingsToggle').getAttribute('aria-expanded'),agentVisible:visible('agentSelect'),hintVisible:visible('agentHint'),otherVisible:['dailyTimeDisplay','btnScheduledTasks','btnDataManagement','themeSelect','themePrev','themeNext','customThemeBtn'].every(visible),triangleSize:parseFloat(getComputedStyle(document.querySelector('#settingsToggle .arrow')).fontSize),toggleTag:document.getElementById('settingsToggle').tagName};})()`);
  const checkCollapsed=state=>{
    assert.equal(state.collapsed,true);assert.equal(state.expanded,'false');assert.equal(state.agentVisible,false);assert.equal(state.hintVisible,false);assert.equal(state.otherVisible,true);assert.equal(state.toggleTag,'BUTTON');assert.ok(state.triangleSize>=18);
  };
  const initialSettings=await settingsState();checkCollapsed(initialSettings);
  assert.equal(await read('!!document.getElementById("aiTaskDetailsBtn")'),false);
  assert.deepEqual(await read('[...document.getElementById("agentSelect").options].map(o=>o.textContent)'),['Claude Code','Codex','CodeBuddy']);
  assert.equal(await read('!!document.getElementById("agentPixelIcon")'),false);
  await read(`document.getElementById('settingsToggle').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  await until('document.getElementById("settingsToggle").getAttribute("aria-expanded")==="true"');
  const expandedSettings=await settingsState();assert.equal(expandedSettings.agentVisible,true);assert.equal(expandedSettings.otherVisible,true);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'char',keyCode:' '});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  await until('document.getElementById("settingsToggle").getAttribute("aria-expanded")==="false"');checkCollapsed(await settingsState());
  await read(`document.getElementById('settingsToggle').click()`);
  const loaded=once(win.webContents,'did-finish-load');win.reload();await loaded;
  await until('agentStatusKnown && memos.length===2');
  checkCollapsed(await settingsState());
  await read(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
  report.checks.push({name:'text-only agents, only agent settings collapse by default and after reload, Enter/Space toggle',initialSettings,expandedSettings});
  assert.equal(await read('document.querySelector("label[for=searchInput]").textContent'),'查找便签');
  assert.equal(await read('document.getElementById("searchHint").textContent'),'');
  const layout=await read(`(()=>{const a=searchInput.getBoundingClientRect(),b=searchMode.getBoundingClientRect();return {input:{top:a.top,bottom:a.bottom,height:a.height},select:{top:b.top,bottom:b.bottom,height:b.height}};})()`);
  assert.ok(Math.abs(layout.input.top-layout.select.top)<1 && Math.abs(layout.input.bottom-layout.select.bottom)<1,JSON.stringify(layout));
  report.checks.push({name:'settings and aligned search',layout});
  await delay(250);
  await shot('desktop-settings-search');
  for(const mode of ['exact','fuzzy']){
    await read(`searchMode.value=${JSON.stringify(mode)};searchInput.value='阅读';searchMode.dispatchEvent(new Event('change'))`);
    await until('filteredMemos?.length===1 && filteredMemos[0].id==="a" && searchHint.textContent==="找到 1 条便签"');
  }
  await read('clearSearch()');
  assert.equal(await read('searchHint.textContent'),'');
  report.checks.push({name:'exact/fuzzy search and clear use API, no explanatory text'});
  for(const theme of ['gold','mintchoc','slate','berry']){
    await read(`applyTheme(${JSON.stringify(theme)})`);
    const style=await read(`({button:getComputedStyle(btnScheduledTasks).backgroundColor})`);
    assert.notEqual(style.button,'rgb(255, 255, 255)');
    report.checks.push({name:'theme '+theme,...style});
  }
  await read('applyTheme("mintchoc")');
  await read('document.getElementById("btnTagGraph").click()');
  await until('document.querySelector("#graphContainer p")?.textContent.includes("选择标签范围")');
  const fixture={id:'polish-graph',generatedAt:now,tags:['阅读'],nodes:[
    {id:'n1',clusterId:'c1',label:'每天读一点',memoIds:['a']},
    {id:'n2',clusterId:'c1',label:'记录小发现',memoIds:['a']},
    {id:'n3',clusterId:'c2',label:'画一只小猫',memoIds:['b']},
    {id:'n4',clusterId:'c2',label:'寻找灵感',memoIds:['b']}
  ],edges:[{source:'n1',target:'n2',relation:'阅读之后记录'},{source:'n2',target:'n3',relation:'把观察画下来'},{source:'n3',target:'n4',relation:'从日常找到灵感'}],clusters:[{id:'c1',title:'阅读与观察',summary:'每天一点发现',memoIds:['a']},{id:'c2',title:'画画与创作',summary:'记录生活灵感',memoIds:['b']}],clusterEdges:[],summaries:[],insights:[]};
  await read('graphHistory=['+JSON.stringify(fixture)+'];graphIndex=0;graphEntryId=null;renderCurrentGraph()');
  await until('document.querySelectorAll(".graph-node").length===4');await delay(1800);
  await read('graphSimulation.stop();void 0');
  const point=await read(`(()=>{const r=document.querySelector('.graph-node-dot').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until('document.querySelector(".graph-node.selected")?.getAttribute("aria-pressed")==="true"');await delay(250);
  await until('Number(getComputedStyle(document.querySelector(".graph-node.selected .graph-node-halo")).opacity)>.4');
  const selected=await read(`(()=>{const n=document.querySelector('.graph-node.selected');return {outline:getComputedStyle(n).outlineStyle,halo:Number(getComputedStyle(n.querySelector('.graph-node-halo')).opacity),stroke:getComputedStyle(n.querySelector('.graph-node-dot')).strokeWidth,links:document.querySelectorAll('.graph-link.is-highlighted').length};})()`);
  assert.equal(selected.outline,'none');assert.ok(selected.halo>.4,JSON.stringify(selected));assert.ok(selected.links>0);
  await shot('graph-selected');
  await read(`document.querySelectorAll('.graph-node')[1].focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  await until('document.querySelectorAll(".graph-node")[1].getAttribute("aria-pressed")==="true"');
  report.checks.push({name:'graph native mouse and keyboard selection, no rectangular outline',...selected});
  await read('document.getElementById("graphClose").click()');
  win.setContentSize(390,844);await delay(250);
  const narrow=await read(`(()=>{const a=searchInput.getBoundingClientRect(),b=searchMode.getBoundingClientRect();return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,topDifference:Math.abs(a.top-b.top),heightDifference:Math.abs(a.height-b.height)};})()`);
  assert.ok(narrow.pageWidth<=narrow.viewport+1,JSON.stringify(narrow));assert.ok(narrow.topDifference<1 && narrow.heightDifference<1);
  await shot('mobile-search');
  await read('document.getElementById("settingsSection").scrollIntoView({block:"center"})');await delay(100);await shot('mobile-settings');
  report.checks.push({name:'390px layout',...narrow});
  for(const [width,height]of [[1280,620],[390,720]]){
    win.setContentSize(width,height);await delay(180);
    await read(`document.querySelector('#tagSelector .ts-more-btn')?.click();document.getElementById('sendBtn').scrollIntoView({block:'end',inline:'nearest'});document.querySelector('.sidebar').scrollTop=document.querySelector('.sidebar').scrollHeight;window.scrollTo(0,document.documentElement.scrollHeight)`);
    await delay(150);
    const actions=await read(`(()=>{const footer=document.querySelector('.app-footer').getBoundingClientRect();const sidebar=document.querySelector('.sidebar');return {width:innerWidth,height:innerHeight,totalTags:document.querySelectorAll('#tagSelector [data-tag]').length,sidebarPaddingTop:parseFloat(getComputedStyle(document.querySelector('.sidebar-input')).paddingTop),sidebarBottom:sidebar.getBoundingClientRect().bottom,footerTop:footer.top,scrollTop:sidebar.scrollTop,buttons:['tagManagerBtn','sendBtn'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {id,top:r.top,bottom:r.bottom,left:r.left,right:r.right,centerHit:e===hit||e.contains(hit)};})};})()`);
    assert.equal(actions.totalTags,14,JSON.stringify(actions));
    for(const button of actions.buttons){assert.ok(button.top>=0 && button.bottom<=actions.footerTop-2,JSON.stringify(actions));assert.ok(button.left>=0 && button.right<=width,JSON.stringify(actions));assert.equal(button.centerHit,true,JSON.stringify(actions));}
    if(width>900)assert.ok(actions.sidebarBottom<=actions.footerTop+1,JSON.stringify(actions));
    report.checks.push({name:'quick record stays above footer with all tags at '+width+'x'+height,...actions});
    await shot('quick-record-'+width+'x'+height);
  }
  assert.deepEqual(report.rendererErrors,[]);
  assert.equal(report.modelCalls,0);
  report.passed=true;
}
app.whenReady().then(run).catch(error=>{report.error=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'server.log'),logs);console.log(JSON.stringify(report));win?.destroy();
  if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});app.exit(process.exitCode || 0);
});
