// Isolated result navigation regression. Only fictional data and a local fake CLI.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-task-navigation-'));
const out=process.env.MEMO_NAVIGATION_UI_DIR || path.join(os.tmpdir(),'memo-task-navigation-evidence-'+Date.now());
const report={checks:[],errors:[]};
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
let child,win,logs='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<400;i++){if(await read(code))return;await pause(25);}throw new Error('Navigation UI timeout: '+code);}
const visible=id=>read(`document.getElementById(${JSON.stringify(id)}).getClientRects().length>0`);
const go=task=>read(`window.openAITaskDestination(${JSON.stringify(task)})`);
function passed(name){report.checks.push(name);console.log('PASS '+name);}
async function shot(name){await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(150);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function run(){
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
 const data=require('../storage/defaults')(),now=new Date().toISOString(),old='2026-01-01T10:00:00.000Z';
 data['settings.json'].theme='greencream';
 data['memos.json'].memos=[{id:'a',content:'虚构：观察树叶。',tags:['观察'],createdAt:now},{id:'b',content:'虚构：画一片树叶。',tags:['创作'],createdAt:now}];
 const graph=(id,label)=>({id,generatedAt:id==='graph-old'?old:now,nodes:[{id:'a',label,memoIds:['a']},{id:'b',label:'画树叶',memoIds:['b']}],edges:[{source:'a',target:'b',relation:'先观察再画'}],clusters:[],clusterEdges:[],summaries:[],insights:[],tags:['观察']});
 data['ai_suggestions.json']={dailyDigest:{date:now.slice(0,10),generatedAt:now,summary:'虚构的本次日报。',tasks:[]},weeklyDigests:[{generatedAt:now,summary:'较新的总结'},{generatedAt:old,summary:'目标旧总结'}],tagSuggestionHistory:[{generatedAt:now,suggestions:[{from:'观察',to:'新观察',reason:'较新的建议'}]},{generatedAt:old,suggestions:[{from:'观察',to:'旧观察',reason:'目标旧建议'}]}],graphHistory:[graph('graph-old','目标旧图谱'),graph('graph-new','较新图谱')]};
 data['habit_pools.json'].pools=[{id:'pool-old',name:'目标旧卡池',description:'合成数据',habits:['观察一片叶子'],createdAt:old},{id:'pool-new',name:'较新卡池',description:'合成数据',habits:['画一片叶子'],createdAt:now}];
 for(const [name,value]of Object.entries(data))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
 const node=process.env.MEMO_TEST_NODE || process.execPath,quote=value=>"'"+value.replace(/'/g,"'\\''")+"'",fake=path.join(root,'fake-claude');
 fs.writeFileSync(fake,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
 const mode=path.join(root,'mode');fs.writeFileSync(mode,'stream-slow');
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 child=spawn(node,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,PORT:String(port),CLAUDE_CLI:fake,MEMO_FAKE_CC_INVALID_FILE:mode},stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',chunk=>logs+=chunk);child.stdout.on('data',chunk=>logs+=chunk);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',()=>{if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code+' '+logs));});});
 win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)report.errors.push(message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(`http://127.0.0.1:${port}/`)}));
 await win.loadURL(`http://127.0.0.1:${port}/`);
 await read(fs.readFileSync(process.env.MEMO_D3_TEST_FILE,'utf8'));
 await until('agentStatusKnown && aiState.configured && typeof openAITaskDestination==="function"');
 assert.equal(await read('document.getElementById("aiTaskModal")'),null);
 await read('document.getElementById("digestBanner").classList.add("digest-collapsed")');
 assert.equal(await go({status:'completed',target:{type:'daily-digest',generatedAt:now}}),false);
 assert.equal(await read('document.getElementById("digestBanner").classList.contains("digest-collapsed")'),true);
 assert.equal(await read('document.querySelector("#digestRegenBtn + [data-ai-task-details]")'),null);
 assert.equal(await read('document.querySelector(".search-bar [data-ai-task-details]")'),null);
 passed('homepage digest and search have no result-navigation entry');

 for(const [type,modal,list]of [['weekly-digest','weeklyModal','weeklyHistory'],['tag-suggestions','tagSuggestModal','tagSuggestHistory']]){
  assert.equal(await go({status:'completed',target:{type,generatedAt:old}}),true);
  assert.equal(await visible(modal),true);
  const item=await read(`(()=>{const e=document.querySelector('#${list} [data-generated-at="${old}"]');return {found:!!e,expanded:!!e&&!e.querySelector('.tag-summary-item-content').classList.contains('collapsed-content')};})()`);
  assert.deepEqual(item,{found:true,expanded:true});passed(type+' opens the requested older record, rather than the latest');
  assert.equal(await read(`(()=>{const e=document.querySelector('#${list} [data-generated-at="${old}"]');return getComputedStyle(e).outlineStyle==='none' && e.getAttribute('tabindex')===null && document.activeElement!==e;})()`),true,'result scrolling must not add a box or move focus onto a whole result');
 }
 assert.equal(await go({status:'completed',target:{type:'graph',id:'graph-old',generatedAt:old}}),true);
 assert.equal(await visible('graphModal'),true);
 assert.equal(await read('graphHistory[graphIndex].id'),'graph-old');
 await until('document.querySelector("#graphContainer .graph-node")');
 assert.equal(await read('getComputedStyle(document.getElementById("graphContainer")).outlineStyle'),'none');
 assert.equal(await read('document.querySelector(".ai-result-highlight")'),null);
 await shot('graph-destination');passed('graph navigation selects its exact saved ID');
 for(const status of ['running','failed']){
  assert.equal(await go({status,error:status==='failed'?'合成图谱失败':null,target:{type:'graph'}}),false);
  assert.equal(await read('graphHistory[graphIndex].id'),'graph-old');
 }
 passed('running and failed tasks cannot activate result navigation');

 assert.equal(await go({status:'completed',target:{type:'habit-wish',step:'purpose',source:'wish'}}),true);
 assert.equal(await visible('habitWishWizard'),true);
 assert.equal(await go({status:'running',target:{type:'habit-pool',step:'generate',source:'wish'}}),false);
 assert.equal(await visible('habitWishWizard'),true);
 passed('running generation cannot open a result or displace the existing dialogue');
 assert.equal(await go({status:'completed',target:{type:'habit-pool',id:'pool-old',source:'wish'}}),true);
 assert.equal(await visible('habitWishWizard'),false);
 assert.equal(await visible('habitPoolDetailModal'),true);
 assert.equal(await read('habitDetailPoolId'),'pool-old');
 assert.equal(await read('document.querySelector("#tagSummaryModal > .modal-content").inert'),false);
 passed('plan dialogue and exact pool navigation release the second-level focus lock');
 await shot('pool-destination');

 assert.equal(await go({status:'completed',target:{type:'habit-pool',id:'deleted-pool',source:'wish'}}),false);
 assert.equal(await visible('tagSummaryModal'),true);
 assert.equal(await visible('habitPoolDetailModal'),false);
 assert.equal(await go({status:'completed',target:{type:'weekly-digest',generatedAt:'1999-01-01T00:00:00.000Z'}}),false);
 assert.equal(await visible('weeklyModal'),true);
 passed('missing results return to their feature without opening a different result');
 assert.equal(await go({status:'failed',error:'合成任务失败',target:{type:'habit-pool',source:'material'}}),false);
 assert.equal(await visible('weeklyModal'),true);
 assert.equal(await visible('habitPoolDetailModal'),false);
 passed('failed generation keeps the existing page instead of offering result navigation');

 win.setContentSize(390,820);await pause(150);
 assert.equal(await go({status:'completed',target:{type:'habit-pool',id:'pool-new',source:'material'}}),true);
 const narrow=await read(`(()=>{const r=document.querySelector('#habitPoolDetailModal .modal-content').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()`);
 assert.ok(narrow.left>=0&&narrow.right<=narrow.width+1);await pause(2600);await shot('pool-destination-narrow');
 passed('390px result navigation remains inside the viewport');

 // Exercise a real fake-model task through the existing UI, including persisted target.
 await read(`document.querySelectorAll('.modal').forEach(e=>e.classList.add('hidden'));document.getElementById('digestRegenBtn').click()`);
 await until('window._ccLatestTask?.status==="running"');
 assert.equal(await read('document.querySelector("#digestRegenBtn + [data-ai-task-details]")'),null);
 assert.equal(await read('[...document.querySelectorAll("[data-ai-task-details]")].some(e=>e.getClientRects().length>0)'),false);
 assert.equal(await read('document.getElementById("aiTaskModal")'),null);
 await until('window._ccLatestTask?.status==="completed" && !document.getElementById("digestRegenBtn").disabled');
 assert.equal(await read('[...document.querySelectorAll("[data-ai-task-details]")].some(e=>e.getClientRects().length>0)'),false,'daily completion must not expose any navigation button');
 assert.equal(await read('getComputedStyle(document.getElementById("digestBanner")).outlineStyle'),'none');
 const task=await read('window._ccLatestTask');
 assert.equal(task.target.type,'daily-digest');assert.ok(task.target.generatedAt);assert.ok(task.messages.some(m=>m.text.length>0));
 const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'latest-ai-task.json'),'utf8'));
 assert.equal(saved.task.id,task.id);assert.equal(saved.task.target.generatedAt,task.target.generatedAt);
 assert.equal(await go(task),false);
 const loaded=once(win.webContents,'did-finish-load');win.reload();await loaded;
 await until('window._ccLatestTask?.status==="completed" && agentStatusKnown');
 assert.equal(await read('window._ccLatestTask.id'),task.id);
 assert.equal(await read('window.openAITaskDestination()'),false);
 passed('daily generation still persists its answer without adding navigation or focus frames, including after reload');
 report.ok=true;
}
app.whenReady().then(run).catch(error=>{report.ok=false;report.error=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{
 if(win&&!win.isDestroyed())await shot('final').catch(()=>{});
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 win?.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
 fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,out}));app.exit(process.exitCode||0);
});
