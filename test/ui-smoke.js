const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process');const {once}=require('events');
const defaults=require('../storage/defaults');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-ui-smoke-'));
const profile=path.join(root,'profile');fs.mkdirSync(profile);
app.setPath('userData',profile);app.disableHardwareAcceleration();
let child,window;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(expression){for(let i=0;i<120;i++){if(await window.webContents.executeJavaScript(expression))return;await delay(50);}throw new Error('UI wait failed: '+expression);}
async function run(){
 const data=defaults(),now=new Date().toISOString();
 data['memos.json'].memos=[{id:'site',content:'想做个人网站，先从首页开始。',tags:['创作'],createdAt:now},{id:'title',content:'今天写了一行标题，终于开始了。',tags:['创作'],createdAt:now},{id:'walk',content:'傍晚去公园散步，留意路边的花。',tags:['日常'],createdAt:now}];
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
 for(const [file,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
 const fake=path.join(root,'fake-claude');const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
 const node=process.env.MEMO_TEST_NODE || process.execPath;
 fs.writeFileSync(fake,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const invalidMode=path.join(root,'invalid-mode');
 child=spawn(node,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,PORT:String(port),CLAUDE_CLI:fake,CODEX_CLI:fake,CODEBUDDY_CLI:path.join(root,'not-installed'),MEMO_FAKE_CC_INVALID_FILE:invalidMode},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',data=>{output+=data;});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup: '+output)),10000);child.stdout.on('data',data=>{output+=data;if(output.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Exited '+code+': '+output));});});
 window=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error('[Renderer]',message);});
 let blockTaskSnapshot=false;
 window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith('http://127.0.0.1:') || (blockTaskSnapshot && details.url.endsWith('/api/ai/task'))}));
 await window.loadURL(`http://127.0.0.1:${port}`);
 await window.webContents.executeJavaScript(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
 await until('typeof memos !== "undefined" && memos.length===3');
 const out=process.env.MEMO_UI_SCREENSHOT_DIR;
 if(out)fs.mkdirSync(out,{recursive:true});
 await until('agentStatusKnown && !document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(`
   if(taskWaitText({task:'标签整理 1/1',elapsedMs:65000})!=='正在处理：标签整理 1/1 · 已等待1分5秒，请稍等')throw new Error('Task duration not shown');
 `);
 await window.webContents.executeJavaScript(`
   var field=document.getElementById('agentSelect');
   if([...field.options].map(option=>option.value).join(',')!=='cc,codex,codebuddy,trae')throw new Error('Wrong assistant options');
   field.value='codex';field.dispatchEvent(new Event('change'));
 `);
 await until('settings.agent==="codex" && !document.getElementById("agentSelect").disabled');
 const loaded=once(window.webContents,'did-finish-load');window.webContents.reload();await loaded;
 await until('agentStatusKnown && settings.agent==="codex" && !document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(`
   var label=document.querySelector('label[for="agentSelect"]').getBoundingClientRect();
   var field=document.getElementById('agentSelect').getBoundingClientRect();
   if(field.x<label.right || Math.abs((field.y+field.height/2)-(label.y+label.height/2))>4)throw new Error('Assistant label and dropdown are not on one row');
   document.getElementById('settingsSection').classList.remove('section-collapsed');
 `);
 if(out)fs.writeFileSync(path.join(out,'agent-settings.png'),(await window.webContents.capturePage()).toPNG());
 fs.writeFileSync(invalidMode,'slow');
 await window.webContents.executeJavaScript(`
   window.remoteDone=false;
   void fetch('/api/cc/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'daily-digest'})}).then(()=>{window.remoteDone=true;});
 `);
 await until('aiState.busy && document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(`
   var field=document.getElementById('agentSelect');field.value='codebuddy';field.dispatchEvent(new Event('change'));
   if(field.value!=='codex')throw new Error('Busy selector accepted a change');
 `);
 if(out)fs.writeFileSync(path.join(out,'agent-busy.png'),(await window.webContents.capturePage()).toPNG());
 await until('window.remoteDone && !document.getElementById("agentSelect").disabled');
 fs.rmSync(invalidMode);
 fs.writeFileSync(invalidMode,'stream-slow');
 blockTaskSnapshot=true; // This check must pass through SSE without snapshot polling.
 await window.webContents.executeJavaScript(`document.getElementById('digestRegenBtn').click()`);
 await until('!document.querySelector("#digestRegenBtn + [data-ai-task-details]").hidden && document.getElementById("digestRegenBtn").disabled');
 await window.webContents.executeJavaScript(`document.querySelector('#digestRegenBtn + [data-ai-task-details]').click()`);
 await until('document.querySelector("#aiTaskOutput pre")?.textContent.length>0 && document.getElementById("aiTaskStatus").dataset.status==="running"');
 const growth=[await window.webContents.executeJavaScript('document.querySelector("#aiTaskOutput pre").textContent.length')];
 for(let i=0;i<80 && growth.length<3;i++) {
   const sample=await window.webContents.executeJavaScript('({chars:document.querySelector("#aiTaskOutput pre")?.textContent.length || 0,running:document.getElementById("aiTaskStatus").dataset.status==="running"})');
   if(sample.running && sample.chars>growth.at(-1))growth.push(sample.chars);
   await delay(15);
 }
 if(growth.length<3)throw new Error('Expected at least three visible text lengths while generating, without polling: '+JSON.stringify(growth));
 console.log(JSON.stringify({liveStreamVisibleGrowth:growth,snapshotPollingBlocked:true}));
 await window.webContents.executeJavaScript(`
   var partialText=document.getElementById('aiTaskOutput').textContent;
   document.getElementById('aiTaskClose').click();
   if(!document.getElementById('agentSelect').disabled)throw new Error('Closing details unlocked the assistant');
   document.getElementById('aiTaskDetailsBtn').click();
   if(document.getElementById('aiTaskOutput').textContent!==partialText)throw new Error('Reopening lost partial text');
   if(document.getElementById('aiTaskOutput').textContent.includes('PRIVATE_THINKING'))throw new Error('Private reasoning leaked');
 `);
 if(out)fs.writeFileSync(path.join(out,'task-stream-partial.png'),(await window.webContents.capturePage()).toPNG());
 await until('document.getElementById("aiTaskStatus").dataset.status==="completed" && !document.getElementById("agentSelect").disabled');
 blockTaskSnapshot=false;
 await window.webContents.executeJavaScript(`document.getElementById('aiTaskClose').click()`);
 fs.writeFileSync(invalidMode,'partial-failure');
 await window.webContents.executeJavaScript(`document.getElementById('digestRegenBtn').click()`);
 await until('document.getElementById("digestRegenBtn").disabled');
 await window.webContents.executeJavaScript(`document.getElementById('aiTaskDetailsBtn').click()`);
 await until('document.getElementById("aiTaskStatus").dataset.status==="failed" && !document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(`
   if(!document.getElementById('aiTaskStage').textContent.includes('登录'))throw new Error('Stream failure lacks a friendly message');
   document.getElementById('aiTaskClose').click();
 `);
 fs.rmSync(invalidMode);

 await window.webContents.executeJavaScript(`var field=document.getElementById('agentSelect');field.value='codebuddy';field.dispatchEvent(new Event('change'));`);
 await until('settings.agent==="codebuddy" && !document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(`(async()=>{
   if(!await checkCCAvailable())throw new Error('Missing assistant was accepted');
   const toast=document.getElementById('appToast').textContent;
   if(!toast.includes('CodeBuddy') || toast.includes('Claude'))throw new Error('Wrong product in missing CLI message');
   var field=document.getElementById('agentSelect');field.value='cc';field.dispatchEvent(new Event('change'));
 })()`);
 await until('settings.agent==="cc" && !document.getElementById("agentSelect").disabled');
 await window.webContents.executeJavaScript(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
 await window.webContents.executeJavaScript(`
   showDigest({date:'2026-04-21 ~ 2026-04-22',summary:'· 2026年4月21日，暂无记录\\n\\n· 2026年4月22日，暂无记录'},true);
   if(!document.getElementById('digestText').textContent.includes('还没有内容哦～'))throw new Error('Legacy empty digest is not friendly');
   if(/口径|旧版|本地日期/.test(document.getElementById('digestBanner').textContent))throw new Error('Technical digest message leaked');
 `);
 if(out) {
   await window.webContents.executeJavaScript(`document.getElementById('digestBanner').scrollIntoView({block:'center'});`);
   await delay(250);
   const rect=await window.webContents.executeJavaScript(`(()=>{const box=document.getElementById('digestBanner').getBoundingClientRect();return {x:Math.max(0,Math.floor(box.x)),y:Math.max(0,Math.floor(box.y)),width:Math.ceil(box.width),height:Math.ceil(box.height)};})()`);
   fs.writeFileSync(path.join(out,'empty-digest.png'),(await window.webContents.capturePage(rect)).toPNG());
 }
 await window.webContents.executeJavaScript(`
   showDigest({date:localDateKey(),from:localDateKey(),summary:'新摘要'});
   if(document.getElementById('digestTitle').textContent.includes('之前'))throw new Error('Current date mislabeled');
   showDigest({date:localDateKey(),empty:true});
   if(!document.getElementById('digestText').textContent.includes('昨天和今天还没有记录哦～'))throw new Error('Empty digest is not friendly');
   const oldMarked=window.marked;
   try {
     window.marked={parse:()=>'<h3>发现</h3><p onclick="window.bad=true"><strong>一个想法</strong><a href="javascript:alert(1)">链接</a></p><script>window.bad=true</script>'};
     const host=document.createElement('div');host.innerHTML=renderMarkdown('test');
     if(!host.querySelector('h3') || !host.querySelector('strong') || host.querySelector('script,[onclick],a[href]'))throw new Error('Markdown rendering is unsafe or loses formatting');
   } finally {window.marked=oldMarked;}
 `);
 await window.webContents.executeJavaScript(`document.getElementById('searchInput').value='完全没有这句话';document.getElementById('searchInput').dispatchEvent(new Event('input'));`);
 await until('filteredMemos && filteredMemos.length===0 && document.getElementById("kanbanGrid").textContent.includes("没有找到记录哦～")');
 await window.webContents.executeJavaScript(`document.getElementById('searchMode').value='fuzzy';document.getElementById('searchInput').value='散步 公园';document.getElementById('searchInput').dispatchEvent(new Event('input'));`);
 await until('filteredMemos && filteredMemos.length===1 && filteredMemos[0].id==="walk"');
 await window.webContents.executeJavaScript(`document.getElementById('searchClearBtn').click();document.getElementById('btnTagGraph').click();`);
 await delay(150);await window.webContents.executeJavaScript(`graphSelectedTags=['空标签'];document.getElementById('graphRegenBtn').click()`);
 await until('!document.getElementById("graphRegenBtn").disabled && document.getElementById("appToast").textContent.includes("还没有记录哦～")');
 await window.webContents.executeJavaScript(`if(graphHistory.length)throw new Error('Empty scope saved a graph');graphSelectedTags=[];document.getElementById('graphRegenBtn').click()`);
 await until('graphHistory.length && graphHistory.at(-1).version===3 && document.querySelectorAll("#graphContainer .graph-node").length===3');
 await delay(350);
 // Relation-label regression uses deliberately long synthetic relationships in memory only.
 await window.webContents.executeJavaScript(`
   window.relationOriginalEdges=graphHistory.at(-1).edges;
   var ids=graphHistory.at(-1).nodes.map(node=>node.id);
   window.longRelation='一起围绕每天坚持阅读和创作展开的长关系说明🌿';
   var fixture={...graphHistory.at(-1),edges:[{source:ids[0],target:ids[1],relation:window.longRelation},{source:ids[1],target:ids[2],relation:'另一段用于检查相邻关系可见性的长说明'}]};
   renderGraph(fixture);
   var labels=[...document.querySelectorAll('#graphContainer .graph-link-label')];
   if(labels.length!==2 || labels.some(label=>getComputedStyle(label).opacity!=='0'))throw new Error('Default graph relation labels were visible');
   if(labels[0].textContent!==Array.from(window.longRelation).slice(0,12).join('')+'…')throw new Error('Long relation was not shortened to 12 code points');
   if(![...document.querySelectorAll('#graphContainer .graph-link title')].some(title=>title.textContent.includes(window.longRelation)))throw new Error('Full relationship was lost from SVG title');
 `);
 await delay(200);if(out)fs.writeFileSync(path.join(out,'graph-default.png'),(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript(`
   var nodes=[...document.querySelectorAll('#graphContainer .graph-node')];
   var visible=()=>[...document.querySelectorAll('#graphContainer .graph-link-label.is-visible')];
   nodes[0].dispatchEvent(new MouseEvent('mouseenter'));
   if(visible().length!==1 || visible()[0].textContent!==Array.from(window.longRelation).slice(0,12).join('')+'…')throw new Error('Hover did not show only adjacent short relationship');
   nodes[0].dispatchEvent(new MouseEvent('mouseleave'));
   if(visible().length)throw new Error('Mouseleave did not restore default hidden labels');
   nodes[2].dispatchEvent(new FocusEvent('focus'));
   if(visible().length!==1)throw new Error('Focus did not show adjacent relationship');
   nodes[2].dispatchEvent(new FocusEvent('blur'));
   if(visible().length)throw new Error('Blur did not restore default labels');
   nodes[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   nodes[1].dispatchEvent(new MouseEvent('mouseleave'));
   if(visible().length!==2 || !nodes[1].classList.contains('selected'))throw new Error('Keyboard-selected node did not retain adjacent relationship labels');
   renderGraph(graphHistory.at(-1));
 `);
 console.log(JSON.stringify({graphRelationsRegression:true,defaultHidden:true,hoverAdjacentOnly:true,shortenedTo12CodePoints:true,fullTitlePreserved:true,mouseleaveReset:true,focusAndBlur:true,keyboardSelectionPersists:true,fixture:'synthetic long relationships in renderer memory only'}));
 await window.webContents.executeJavaScript(`document.querySelector('#graphContainer .graph-node').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
 await until('document.querySelectorAll(".ga-source-text").length>=3');
 await delay(200);
 if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'graph-expanded.png'),(await window.webContents.capturePage()).toPNG());}
 await window.webContents.executeJavaScript(`document.getElementById('graphCollapseAll').click()`);
 await until('document.querySelectorAll("#graphContainer .graph-node").length===2 && document.getElementById("graphCollapseAll").textContent==="全部展开"');
 await delay(150);if(out)fs.writeFileSync(path.join(out,'graph-collapsed.png'),(await window.webContents.capturePage()).toPNG());
 fs.writeFileSync(invalidMode,'empty:graph');
 await window.webContents.executeJavaScript(`document.getElementById('graphRegenBtn').click()`);
 await until('!document.getElementById("graphRegenBtn").disabled && document.getElementById("appToast").textContent.includes("这次没整理好哦～")');
 fs.unlinkSync(invalidMode);
 await window.webContents.executeJavaScript(`(async()=>{
   if(graphHistory.length!==1)throw new Error('Failed graph changed history');
   if(document.getElementById('appToast').textContent.includes('JSON'))throw new Error('Technical error leaked');
   document.getElementById('graphCollapseAll').click();
   const updated=await api('/api/memos/site',{method:'PUT',body:JSON.stringify({content:'改过的想法'})});
   memos[memos.findIndex(memo=>memo.id==='site')]=updated;
   document.querySelectorAll('#graphContainer .graph-node').forEach(node=>{if(node.__data__.id==='site')node.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
   if(!document.getElementById('graphSummaryPanel').textContent.includes('改过的想法'))throw new Error('Edited source not shown');
   await api('/api/memos/walk',{method:'DELETE'});memos=memos.filter(memo=>memo.id!=='walk');
   document.querySelectorAll('#graphContainer .graph-node').forEach(node=>{if(node.__data__.id==='walk')node.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
   if(!document.getElementById('graphSummaryPanel').textContent.includes('原来的便签找不到了哦～'))throw new Error('Deleted source not handled');
   const bubbles=[];const savedBubble=_showCCBubble;
   try {_showCCBubble=text=>bubbles.push(text);showCCTask('失败检查');hideCCTask('失败检查',false);}finally{_showCCBubble=savedBubble;}
   if(bubbles.at(-1).includes('完成'))throw new Error('Failed task reported success');
   if(bubbles.some(text=>/cc/i.test(text)))throw new Error('Assistant subject leaked into task bubble');
 })()`);
 await window.webContents.executeJavaScript(`document.getElementById('graphModal').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
 await delay(100);await until('document.getElementById("graphModal").classList.contains("hidden")');
 await window.webContents.executeJavaScript(`(async()=>{
   await api('/api/habit/pools/default-pool',{method:'PUT',body:JSON.stringify({habits:[]})});
   habitSelectedPoolId='default-pool';doHabitDraw();
 })()`);
 await until('document.getElementById("appToast").textContent.includes("还没有习惯哦～") && !document.getElementById("habitDrawStep1").classList.contains("hidden")');
 await window.webContents.executeJavaScript(`(async()=>{
   const field=document.getElementById('storageBackupFile'),file=new File([''],'large.sqlite');
   Object.defineProperty(file,'size',{value:101*1024*1024});Object.defineProperty(field,'files',{configurable:true,value:[file]});
   field.dispatchEvent(new Event('change'));
   if(!document.getElementById('storageMessage').textContent.includes('100 MB'))throw new Error('Oversized backup was not blocked');
   const originalFetch=window.fetch;
   try {
     window.fetch=async()=>({ok:false,status:400,json:async()=>({error:'SQLITE_CORRUPT: database disk image is malformed'})});
     try {await storageRequest('/api/storage/restore',{method:'POST'});throw new Error('Expected restore failure');}
     catch(error) {if(/SQLite|CORRUPT|malformed/i.test(error.message) || !error.detail.includes('SQLITE_CORRUPT'))throw new Error('Storage error was not separated from logs');}
   } finally {window.fetch=originalFetch;}
 })()`);
 await window.webContents.executeJavaScript(`
   document.getElementById('btnTagGraph').click();
 `);
 await until('document.querySelectorAll("#graphContainer .graph-node").length===3');
 console.log(JSON.stringify({acceptanceStage:'graph keyboard and zoom'}));
 await window.webContents.executeJavaScript(`
   var node=document.querySelector('#graphContainer .graph-node');
   node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   if(!node.classList.contains('selected'))throw new Error('Enter did not select graph source');
   var other=document.querySelectorAll('#graphContainer .graph-node')[1];
   other.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));
   if(!other.classList.contains('selected'))throw new Error('Space did not select graph source');
   document.querySelector('#graphSummaryPanel .ga-source-button').click();
   if(document.getElementById('memoDetailModal').classList.contains('hidden'))throw new Error('Graph source did not open memo detail');
   document.getElementById('memoDetailClose').click();
   var svg=document.querySelector('#graphContainer svg'),box=svg.getBoundingClientRect();
   svg.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,view:window,clientX:box.x+box.width/2,clientY:box.y+box.height/2,deltaY:-100}));
 `);
 await until('document.querySelector("#graphContainer svg").__zoom.k>1');
 await delay(180);
 console.log(JSON.stringify({acceptanceStage:'graph drag and fullscreen'}));
 await window.webContents.executeJavaScript(`
   var node=document.querySelector('#graphContainer .graph-node'),box=node.querySelector('circle').getBoundingClientRect();
   var x=box.x+box.width/2,y=box.y+box.height/2;
   node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0,buttons:1}));
   window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,view:window,clientX:x+35,clientY:y+20,buttons:1}));
   if(node.__data__.fx===null || node.__data__.fx===undefined)throw new Error('Graph drag did not activate');
   window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window,clientX:x+35,clientY:y+20,button:0,buttons:0}));
   if(node.__data__.fx!==null || node.__data__.fy!==null)throw new Error('Graph drag did not release');
 `);
 await delay(50); // d3.drag suppresses the synthetic click immediately after mouseup.
 await window.webContents.executeJavaScript(`
   document.getElementById('graphFullscreen').click();
   if(!document.querySelector('#graphModal .modal-graph-analysis').classList.contains('graph-fullscreen'))throw new Error('Graph fullscreen did not enter');
 `);
 await delay(500);
 console.log(JSON.stringify(await window.webContents.executeJavaScript(`(()=>{
   const container=document.getElementById('graphContainer'),svg=container.querySelector('svg');
   const nodes=[...container.querySelectorAll('.graph-node')].map(node=>({id:node.__data__.id,x:node.__data__.x,y:node.__data__.y,fx:node.__data__.fx,fy:node.__data__.fy,transform:node.getAttribute('transform')}));
   return {graphFullscreenGeometry:true,width:container.clientWidth,height:container.clientHeight,svgWidth:svg.getAttribute('width'),svgHeight:svg.getAttribute('height'),nodes};
 })()`)));
 if(out)fs.writeFileSync(path.join(out,'graph-fullscreen.png'),(await window.webContents.capturePage()).toPNG());
 window.setSize(1024,800);await delay(180);
 console.log(JSON.stringify({acceptanceStage:'graph resize and history'}));
 await window.webContents.executeJavaScript(`
   var container=document.getElementById('graphContainer'),svg=container.querySelector('svg');
   if(Math.abs(Number(svg.getAttribute('width'))-container.clientWidth)>1)throw new Error('Graph did not follow resize');
   document.getElementById('graphFullscreen').click();
   if(document.querySelector('#graphModal .modal-graph-analysis').classList.contains('graph-fullscreen'))throw new Error('Graph fullscreen did not exit');
   document.getElementById('graphRegenBtn').click();
 `);
 await until('graphHistory.length===2 && graphIndex===1 && !document.getElementById("graphRegenBtn").disabled');
 await window.webContents.executeJavaScript(`
   document.getElementById('graphPrev').click();if(graphIndex!==0 || !document.getElementById('graphPrev').disabled)throw new Error('Graph previous history failed');
   document.getElementById('graphNext').click();if(graphIndex!==1 || !document.getElementById('graphNext').disabled)throw new Error('Graph next history failed');
   document.getElementById('graphDeleteCurrent').click();document.getElementById('confirmCancel').click();
   if(graphHistory.length!==2)throw new Error('Cancelled graph deletion changed history');
   document.getElementById('graphDeleteCurrent').click();document.getElementById('confirmOk').click();
 `);
 await until('graphHistory.length===1');
 await window.webContents.executeJavaScript(`document.getElementById('graphDeleteCurrent').click();document.getElementById('confirmOk').click()`);
 await until('graphHistory.length===0 && document.getElementById("graphCollapseAll").disabled');
 console.log(JSON.stringify({acceptanceStage:'wish preset answers and restart'}));
 await window.webContents.executeJavaScript(`
   if(document.getElementById('graphNav').style.display!=='none' || !document.getElementById('graphContainer').textContent.includes('还没有图谱'))throw new Error('Deleting last graph did not restore empty state');
   document.getElementById('graphClose').click();document.getElementById('btnHabitTrack').click();document.getElementById('habitWishStart').click();
   document.getElementById('habitWishInput').value='培养阅读习惯';document.getElementById('habitWishForm').requestSubmit();
 `);
 await until('document.querySelectorAll(".habit-wish-option").length===4');
 await window.webContents.executeJavaScript(`document.querySelector('.habit-wish-option').click()`);
 await until('document.querySelectorAll(".habit-wish-option").length===4 && document.getElementById("habitWishStep").textContent.startsWith("3 / 3")');
 await window.webContents.executeJavaScript(`document.querySelector('.habit-wish-option').click()`);
 await until('!document.getElementById("habitWishSuccess").classList.contains("hidden")');
 await window.webContents.executeJavaScript(`
   var pool=habitPools.find(pool=>pool.wishContext?.wish==='培养阅读习惯');
   if(!pool || pool.habits.length!==30 || !pool.wishContext.purpose || !pool.wishContext.effort)throw new Error('Preset wish answers were not saved');
 `);
 if(out)fs.writeFileSync(path.join(out,'wish-preset-success.png'),(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript(`
   document.getElementById('habitWishRestart').click();
   if(document.getElementById('habitWishInput').value || document.querySelectorAll('#habitWishMessages .user').length || !document.getElementById('habitWishStep').textContent.startsWith('1 / 3'))throw new Error('Changing wish did not reset the conversation');
 `);
 console.log(JSON.stringify({streamingReply:true,streamReopen:true,streamFailure:true,agentSelection:true,agentReload:true,agentBusyLock:true,agentMissingMessage:true,agentLayout:true,localSearch:true,emptySearch:true,legacyDigestFriendly:true,emptyDigestFriendly:true,markdownSafe:true,expandedNodes:3,collapsedClusters:2,sourcePanel:true,editedSource:true,deletedSource:true,emptyGraphRejected:true,failureBubble:true,emptyPoolRecovery:true,oversizedBackupBlocked:true,friendlyStorageErrors:true,overlayClose:true,graphKeyboardEnterAndSpace:true,graphSourceDetail:true,graphZoom:true,graphDrag:true,graphFullscreen:true,graphResize:true,graphPreviousAndNext:true,graphDeleteCancel:true,graphDeleteLast:true,wishPresetAnswers:true,wishRestart:true,graphRelationDefaultHidden:true,graphRelationHoverAdjacentOnly:true,graphRelationShortened:true,graphRelationFullTitle:true,graphRelationMouseleaveReset:true,graphRelationFocusAndBlur:true,graphRelationKeyboardSelectionPersists:true}));
}
app.whenReady().then(run).catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
 window?.destroy();if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
 try{fs.rmSync(root,{recursive:true,force:true});}catch{}
 app.exit(process.exitCode || 0);
});
