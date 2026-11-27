// Shared UI baseline: isolated temporary HTTP + SQLite, actual Electron + official D3.
// Only ordinary literal HTML is used to verify plain-text editing. No model requests.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-fix-frontend-'));
const out=path.resolve(process.env.MEMO_FIX_UI_OUT || path.join(__dirname,'final-acceptance-evidence/2026-11-25-fix-01/ui'));
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const report={cases:[],scope:'Shared frontend baseline for cc/codex/codebuddy; isolated real server + SQLite; fictional records; actual official D3; no model calls',startedAt:new Date().toISOString(),externalRequests:[],modelRequests:[]};
let win,child,base,logs='';const delay=ms=>new Promise(r=>setTimeout(r,ms));
const read=async code=>{const r=await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (0,eval)(${JSON.stringify(code)})};}catch(e){return {ok:false,error:e.stack};}})()`);if(!r.ok)throw Error(r.error);return r.value;};
const click=id=>read(`document.getElementById(${JSON.stringify(id)}).click()`);
const save=()=>fs.writeFileSync(path.join(out,'summary-frontend.json'),JSON.stringify(report,null,2));
const ev=file=>path.relative(__dirname,path.join(out,file));
async function shot(name){await delay(80);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());return ev(name+'.png');}
async function until(code){for(let i=0;i<250;i++){if(await read(code))return;await delay(30);}throw Error('UI wait timed out '+code);}
async function check(id,fn){const c={id,status:'running',detail:'',testedAt:new Date().toISOString(),verificationMode:'shared-baseline',agents:['cc','codex','codebuddy'],evidence:[ev('summary-frontend.json')]};report.cases.push(c);try{await fn(c);if(c.status==='running')c.status='passed';}catch(e){c.status='failed';c.detail=e.stack;c.evidence.push(await shot(id+'-failed').catch(()=>null));process.exitCode=1;}save();console.log(JSON.stringify(c));}
async function key(code){win.webContents.sendInputEvent({type:'keyDown',keyCode:code});if(code==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:code});await delay(70);}
const geometryCode=`(()=>{const elements=[...document.querySelectorAll('.graph-node text,.graph-cluster-label')];const labels=elements.map((e,i)=>{const r=e.getBoundingClientRect();return {i,kind:e.matches('.graph-cluster-label')?'theme':'node',text:e.textContent,title:e.parentElement.querySelector('title')?.textContent,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};});const collisions=[];for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j];if(a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y)collisions.push([i,j]);}const r=document.getElementById('graphContainer').getBoundingClientRect();const clipped=labels.filter(a=>a.x<r.x-.5||a.right>r.right+.5||a.y<r.y-.5||a.bottom>r.bottom+.5).map(a=>a.i);return {labels,collisions,clipped,alpha:graphSimulation.alpha(),container:{x:r.x,y:r.y,width:r.width,height:r.height}};})()`;
async function run(){
 const data=require('../storage/defaults')(),now=new Date().toISOString();
 const literal='普通文字 </textarea><strong data-literal="sample">原样保留的 HTML 字面文本</strong> &amp; <em>继续记录</em>\n第二行。';
 const long='今天走过街角的小花园，读了几页喜欢的书，想把平凡的发现记录下来。\n'.repeat(320)+'这是长便签的最后一句。';
 data['settings.json'].tags=['日常','创作'];data['settings.json'].agent='cc';
 data['memos.json'].memos=[{id:'fix-literal',content:literal,tags:['日常'],createdAt:now},{id:'fix-long',content:long,tags:['日常','创作'],createdAt:now},{id:'fix-source',content:'日常记录：沿着河岸散步。',tags:['创作'],createdAt:now}];
 data['habit_pools.json'].pools=[];data['habit_log.json'].logs=[];data['scheduled_tasks.json'].tasks=[];
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);for(const [f,v]of Object.entries(data))fs.writeFileSync(path.join(dataDir,f),JSON.stringify(v));
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;
 const node=process.env.MEMO_TEST_NODE||process.execPath,missing=path.join(root,'not-installed');
 child=spawn(node,[path.join(project,'server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',PORT:String(port),MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,CLAUDE_CLI:missing,CODEX_CLI:missing,TRAE_CLI:missing,CODEBUDDY_CLI:missing},stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',c=>logs+=c);await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error(logs)),10000);child.stdout.on('data',c=>{logs+=c;if(logs.includes('Memo server running')){clearTimeout(t);resolve();}});child.once('exit',code=>{clearTimeout(t);reject(Error('server exit '+code+' '+logs));});});
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level==='warning')logs+='\nRENDERER '+event.message;});
 win.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(d,cb)=>{const local=d.url.startsWith(base+'/');if(!local)report.externalRequests.push(d.url);if(local&&/\/api\/cc\/(ask|.*(?:generate|analyze))/.test(d.url)){report.modelRequests.push(d.url);cb({cancel:true});return;}cb({cancel:!local && d.url!=='https://d3js.org/d3.v7.min.js'});});
 await win.loadURL(base);await until('agentStatusKnown && memos.length===3 && document.querySelectorAll(".memo-card").length===3');
 await check('SEC02',async c=>{
   await read('editMemo("fix-literal")');
   const state=await read(`(()=>{const card=document.querySelector('[data-id="fix-literal"]'),input=card.querySelector('.memo-edit-input');return {value:input.value,textareaCount:card.querySelectorAll('textarea').length,extraLiteralElements:card.querySelectorAll('strong,em,[data-literal]').length,hasSave:!!card.querySelector('.memo-edit-save'),hasCancel:!!card.querySelector('.memo-edit-cancel')};})()`);
   assert.equal(state.value,literal);assert.equal(state.textareaCount,1);assert.equal(state.extraLiteralElements,0);assert.ok(state.hasSave&&state.hasCancel);
   c.evidence.push(await shot('SEC02-literal-edit'));
   await read(`document.querySelector('[data-id="fix-literal"] .memo-edit-save').click()`);await until('!document.querySelector(".memo-card.editing")');
   const rows=await read('fetch("/api/memos").then(r=>r.json())');assert.equal(rows.find(m=>m.id==='fix-literal').content,literal);
   await read('editMemo("fix-literal")');assert.equal(await read('document.querySelector(".memo-edit-input").value'),literal);await read('document.querySelector(".memo-edit-cancel").click()');
   c.metrics=state;c.detail='普通HTML字面文本（含textarea结束标签、strong/em及实体文本）编辑时value逐字一致，未产生额外HTML元素；保存经过真实HTTP/SQLite后原样，重新编辑一致。无事件或脚本输入。';
 });
 await check('UI05',async c=>{
   c.metrics=[];
   for(const width of [1280,390]){
     win.setContentSize(width,width===390?844:900);await delay(180);await read('window.scrollTo(0,0);showMemoDetail("fix-long")');
     const top=await read(`(()=>{const e=document.getElementById('memoDetailContent'),h=document.getElementById('memoDetailTitle').getBoundingClientRect(),b=document.getElementById('memoDetailClose').getBoundingClientRect();return {scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflowY:getComputedStyle(e).overflowY,title:{top:h.top,bottom:h.bottom},close:{top:b.top,bottom:b.bottom,right:b.right},viewportHeight:innerHeight,textLength:e.textContent.length};})()`);
     assert.ok(top.scrollHeight>top.clientHeight);assert.equal(top.overflowY,'auto');assert.equal(top.scrollTop,0);assert.equal(top.textLength,long.length);assert.ok(top.title.top>=0&&top.close.top>=0&&top.close.bottom<=top.viewportHeight);
     const bottom=await read(`(()=>{const e=document.getElementById('memoDetailContent');e.scrollTop=e.scrollHeight;const r=document.createRange();r.setStart(e.firstChild,e.textContent.length-13);r.setEnd(e.firstChild,e.textContent.length);const last=r.getBoundingClientRect(),box=e.getBoundingClientRect(),h=document.getElementById('memoDetailTitle').getBoundingClientRect(),b=document.getElementById('memoDetailClose').getBoundingClientRect();return {scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,lastLine:{top:last.top,bottom:last.bottom},content:{top:box.top,bottom:box.bottom},title:{top:h.top,bottom:h.bottom},close:{top:b.top,bottom:b.bottom},viewportHeight:innerHeight};})()`);
     assert.ok(bottom.scrollTop>0);assert.ok(Math.abs(bottom.scrollTop+bottom.clientHeight-bottom.scrollHeight)<=1);assert.ok(bottom.lastLine.top>=bottom.content.top-.5&&bottom.lastLine.bottom<=bottom.content.bottom+.5);assert.equal(bottom.title.top,top.title.top);assert.equal(bottom.close.top,top.close.top);
     c.evidence.push(await shot('UI05-long-detail-bottom-'+width));await read('document.getElementById("memoDetailClose").focus()');await key('Return');assert.equal(await read('document.getElementById("memoDetailModal").classList.contains("hidden")'),true);
     await read('showMemoDetail("fix-long")');assert.equal(await read('document.getElementById("memoDetailContent").scrollTop'),0);await click('memoDetailClose');c.metrics.push({width,top,bottom,keyboardClose:true,reopenAtTop:true});
   }
   const rows=await read('fetch("/api/memos").then(r=>r.json())');assert.equal(rows.find(m=>m.id==='fix-long').content,long);c.detail=`1280px/390px正文独立滚动到最后一句，标题和关闭按钮位置不变且可达，Enter关闭、重开回顶部；${long.length}字正文经HTTP核对未改变。`;
 });
 await check('GUI08',async c=>{
   if(!await read('typeof d3!=="undefined"')){const d3Path=process.env.MEMO_D3_SOURCE || '/private/tmp/memo-acceptance-d3.v7.min.js';const source=fs.readFileSync(d3Path,'utf8');assert.match(source.slice(0,150),/https:\/\/d3js.org v7\./);await win.webContents.executeJavaScript(source);report.d3={source:'https://d3js.org/d3.v7.min.js',fallbackLocalOfficialSource:d3Path,sha256:crypto.createHash('sha256').update(source).digest('hex')};}
   report.d3={...report.d3,version:await read('d3.version')};
   const titles=['日常散步阅读与窗台植物照料','周末朋友聚会与轻松创作想法','花园观察绘画与生活素材整理','睡前阅读复盘与下一周小计划'];
   const nodes=Array.from({length:16},(_,i)=>({id:'ordinary-node-'+i,clusterId:'cluster-'+Math.floor(i/4),label:'第'+(i+1)+'条花园散步阅读和窗边绘画的普通想法',tag:titles[Math.floor(i/4)],memoIds:['fix-source']}));
   const fixture={id:'ordinary-long-label-graph',generatedAt:now,tags:['日常','创作'],nodes,edges:nodes.slice(1).map((n,i)=>({source:nodes[i].id,target:n.id,relation:'同一生活主题的延伸想法'})),clusters:titles.map((title,i)=>({id:'cluster-'+i,title,summary:'把生活中的小发现留在手帐里。',memoIds:['fix-source']})),clusterEdges:[{source:'cluster-0',target:'cluster-2',relation:'花园生活的共同主题'}],summaries:[],insights:[],coverage:{processedCount:3,matchedCount:3,batchCount:1}};
   fs.writeFileSync(path.join(out,'GUI08-ordinary-fixture.json'),JSON.stringify(fixture,null,2));c.evidence.push(ev('GUI08-ordinary-fixture.json'));c.metrics=[];
   for(const width of [1280,390]){
     win.setContentSize(width,width===390?844:900);await delay(400);await click('btnTagGraph');await delay(200);
     await read('graphHistory=['+JSON.stringify(fixture)+'];graphIndex=0;graphEntryId=null;renderCurrentGraph()');await until('document.querySelectorAll(".graph-node").length===16');await delay(5500);
     const geometry=await read(geometryCode);c.metrics.push({width,expanded:geometry});assert.equal(geometry.labels.length,20);assert.deepEqual(geometry.collisions,[]);assert.deepEqual(geometry.clipped,[]);
     assert.ok(geometry.labels.filter(x=>x.kind==='node').every(x=>Array.from(x.text.replace(/…$/,'')).length<=8&&x.width<=100.5));assert.ok(geometry.labels.filter(x=>x.kind==='theme').every(x=>Array.from(x.text.replace(/…$/,'')).length<=12&&x.width<=156.5));assert.ok(geometry.labels.every(x=>x.title!==x.text&&x.title.startsWith(x.text.replace(/…$/,''))));
     c.evidence.push(await shot('GUI08-expanded-'+width));
     assert.equal(await read('getComputedStyle(document.querySelector(".graph-node text")).pointerEvents'),'auto');
     await read(`document.querySelector('.graph-node').dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));`);const hovered=await read('document.querySelectorAll(".graph-link-label.is-visible").length');assert.ok(hovered>0);
     await read(`document.querySelector('.graph-node').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);assert.equal(await read('document.querySelector("#graphSummaryPanel .ga-sum-card-header").textContent'),nodes[0].label);assert.equal(await read('document.querySelectorAll(".graph-link-label.is-visible").length'),hovered);assert.ok(await read('!!document.querySelector("#graphSummaryPanel .ga-source-button")'));
     await read(`document.querySelector('.graph-cluster-heading').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);assert.equal(await read('document.querySelector("#graphSummaryPanel .ga-sum-card-header").textContent'),titles[0]);
     const sourceReachable=await read(`(()=>{const e=document.querySelector('#graphSummaryPanel .ga-source-button');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewportHeight:innerHeight,reachable:r.top>=0&&r.bottom<=innerHeight};})()`);assert.ok(sourceReachable.reachable);
     await read(`document.querySelector('#graphSummaryPanel .ga-source-button').click()`);assert.equal(await read('document.getElementById("memoDetailContent").textContent'),'日常记录：沿着河岸散步。');await click('memoDetailClose');
     await read(`document.querySelector('.ga-body').scrollTop=0`);await delay(80);
     // Actual pointer drag through Chromium, not mutation of node coordinates.
     const start=await read(`(()=>{const e=document.querySelector('.graph-node'),r=e.querySelector('circle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,transform:e.getAttribute('transform')};})()`);
     win.webContents.focus();win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(start.x),y:Math.round(start.y)});await delay(60);
     win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(start.x),y:Math.round(start.y)});await until('graphSimulation.nodes()[0].fx!=null');
     const fixedStart=await read('({x:graphSimulation.nodes()[0].fx,y:graphSimulation.nodes()[0].fy})');
     win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:Math.round(start.x+25),y:Math.round(start.y+15),movementX:25,movementY:15});
     await until(`Math.abs(graphSimulation.nodes()[0].fx-${fixedStart.x})>10`);const fixedDuring=await read('({x:graphSimulation.nodes()[0].fx,y:graphSimulation.nodes()[0].fy})');
     win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(start.x+25),y:Math.round(start.y+15)});await until('graphSimulation.nodes()[0].fx==null');assert.ok(Math.abs(fixedDuring.x-fixedStart.x)>10);
     const svg=await read(`(()=>{const r=document.querySelector('#graphContainer svg').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(svg.x),y:Math.round(svg.y),deltaY:80,deltaX:0,canScroll:true});await delay(180);const zoom=await read('document.querySelector("#graphContainer svg").__zoom.k');assert.notEqual(zoom,1);
     await click('graphCollapseAll');await until('document.querySelectorAll(".graph-node").length===4');await delay(1800);const collapsed=await read(geometryCode);assert.equal(collapsed.labels.length,4);assert.deepEqual(collapsed.collisions,[]);assert.deepEqual(collapsed.clipped,[]);assert.ok(collapsed.labels.every(x=>Array.from(x.text.replace(/…$/,'')).length<=12));
     c.metrics.at(-1).collapsed=collapsed;c.metrics.at(-1).interactions={hoverRelations:hovered,selectedFullText:true,themeFullText:true,sourceDetail:true,sourceReachable,pointerDrag:true,zoom};c.evidence.push(await shot('GUI08-collapsed-'+width));
     await click('graphCollapseAll');await until('document.querySelectorAll(".graph-node").length===16');await click('graphClose');
   }
   win.setContentSize(1280,900);await delay(350);await click('btnTagGraph');await delay(150);
   const legacy={id:'legacy-short',generatedAt:now,nodes:[{id:'old-1',label:'旧记录一',tag:'日常',memoIds:['fix-source']},{id:'old-2',label:'旧记录二',tag:'日常',memoIds:['fix-source']}],edges:[{source:'old-1',target:'old-2',relation:'相关'}]};
   await read('graphHistory=['+JSON.stringify(legacy)+'];graphIndex=0;graphEntryId=null;renderCurrentGraph()');await until('document.querySelectorAll(".graph-node").length===2');await delay(1000);const old=await read(geometryCode);assert.deepEqual(old.collisions,[]);assert.deepEqual(old.clipped,[]);await click('graphCollapseAll');await until('document.querySelectorAll(".graph-node").length===1');await click('graphClose');c.legacyGraph=true;
   c.detail='真实D3长中文16节点/4主题，桌面与390px均等待5.5秒测量全部20个标签：零重叠、零容器裁切；按字符及实际像素省略。悬浮/选中关系、节点及主题完整文本、来源详情、真实指针拖动/滚轮缩放、簇折叠/展开、无clusters旧图兼容均通过。';
 });
 assert.deepEqual(report.modelRequests,[]);report.finishedAt=new Date().toISOString();report.tempDataRemoved=true;report.fixtureLongCharacters=long.length;report.noModelRequests=true;
}
app.whenReady().then(run).catch(e=>{report.fatalError=e.stack;console.error(e.stack);process.exitCode=1;}).finally(async()=>{save();fs.writeFileSync(path.join(out,'server-frontend.log'),logs);win?.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(process.exitCode||0);});
