// Explicit real-CLI desktop acceptance run. This sends only eight fictional notes.
// No fake model/CLI is used; every generated result comes from the selected CLI.
// Run with Electron, MEMO_TEST_AGENT=codex|codebuddy and MEMO_TEST_NODE=Node22.16+.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {resolveCli,getSelectableAgent}=require('../agents');
const agent=process.env.MEMO_TEST_AGENT || 'codex';
const graphOnly=process.env.MEMO_LIVE_UI_GRAPH_ONLY==='1';
let selectedAgent;
try {
  selectedAgent=getSelectableAgent(agent);
  if(!['codex','codebuddy'].includes(agent))throw new Error('MEMO_TEST_AGENT must be codex or codebuddy; this runner does not accept simulated CC.');
} catch(error) { console.error('Real CLI UI acceptance rejected before startup: '+error.message);process.exit(1); }
const project=path.resolve(__dirname,'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-real-ui-'+agent+'-'));
const evidence=path.resolve(process.env.MEMO_ACCEPTANCE_OUT || path.join(__dirname,'acceptance-evidence','live-ui',agent));
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{}); // Finish report/server cleanup before exiting Electron.
const resultName=graphOnly ? 'graph-retest.json' : 'result.json';
const report={agent,mode:graphOnly ? 'real-cli-ui-graph-retest' : 'real-cli-ui',realCli:true,fakeModel:false,fictionalRecords:8,startedAt:new Date().toISOString(),checks:[],screenshots:[],snapshotPollingBlocked:true};
const placeholder='Synthetic acceptance placeholder; regenerate this digest using the real CLI.';
const timeoutMs=Number(process.env.MEMO_LIVE_UI_TIMEOUT_MS || 300000);
let child,window,base,logs='',phaseStartedAt=0,currentCheck=null;
const browserErrors=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=code=>window.webContents.executeJavaScript(code);
function persist(){const file=path.join(evidence,resultName);fs.writeFileSync(file+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function passed(id,label,details={}){report.checks.push({id,label,status:'passed',details});persist();console.log(JSON.stringify({agent,check:id,status:'passed',...details}));}
function begin(id,label){currentCheck={id,label,startedAt:new Date().toISOString()};report.currentCheck=currentCheck;phaseStartedAt=Date.now();persist();console.log(JSON.stringify({agent,started:id}));}
async function capture(filename){
  if(!window || window.isDestroyed())return;
  if(graphOnly)filename='graph-retest-'+filename;
  await read(`Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,1000))])`);
  await delay(150); // capturePage must observe the painted frame, not only updated DOM.
  const file=path.join(evidence,filename);fs.writeFileSync(file,(await window.webContents.capturePage()).toPNG());report.screenshots.push(filename);persist();
}
async function until(expression,timeout=15000,{task=false}={}){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(await read(expression))return;
    if(task){
      const state=await read(`({status:window._ccLatestTask?.status,stage:window._ccLatestTask?.error || window._ccLatestTask?.stage,started:window._ccLatestTask?.startedAt})`);
      // Task metadata is updated by SSE. Do not turn a failed real call into a retry/fake.
      if(state.status==='failed')throw new Error('Real '+agent+' UI task failed: '+state.stage+'\n'+logs.slice(-5000));
    }
    await delay(40);
  }
  throw new Error('Real '+agent+' UI wait timed out: '+expression+'\n'+logs.slice(-5000));
}
async function json(route){const response=await fetch(base+route,{signal:AbortSignal.timeout(10000)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
async function waitButtonFinished(id){
  await until(`document.getElementById(${JSON.stringify(id)}).disabled`,15000);
  await until(`!document.getElementById(${JSON.stringify(id)}).disabled && !document.getElementById('agentSelect').disabled`,timeoutMs,{task:true});
}
async function run(){
  begin('cli-and-isolation','真实 CLI、临时数据库及独立桌面会话');
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MEMO_FAKE_'))delete env[key];
  const cli=resolveCli(agent,{env,configDir:project});assert.ok(cli,'No installed real CLI found for '+agent);
  report.cli=cli;report.cliVersion=execFileSync(cli,['--version'],{env,encoding:'utf8',timeout:15000}).trim();
  const node=process.env.MEMO_TEST_NODE || process.execPath;
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  const fixture=require('../storage/defaults')();
  const pairs=[['reading','books'],['fitness','exercise'],['cooking','recipes'],['music','songs'],['travel','trips'],['coding','programming'],['films','movies'],['gardening','plants']];
  const now=new Date().toISOString(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  fixture['settings.json'].agent=agent;fixture['settings.json'].tags=pairs.flat();
  fixture['memos.json'].memos=pairs.map((tags,index)=>({id:'fictional-ui-'+(index+1),content:'Fictional integration-test record about '+tags.join(' and ')+'. Both labels describe the same activity. Tomorrow I will spend five minutes on this activity.',tags,createdAt:now,updatedAt:now}));
  fixture['ai_suggestions.json'].tagSuggestionHistory=[];fixture['ai_suggestions.json'].graphHistory=[];fixture['ai_suggestions.json'].weeklyDigests=[];
  // Makes the existing visible daily "regenerate" control accessible on a fresh test installation.
  // This placeholder is not a generated success and must be replaced by the real response below.
  fixture['ai_suggestions.json'].dailyDigest={date:today,from:today,summary:placeholder,tasks:[],tagTrends:{},generatedAt:now,empty:false};
  fixture['habit_pools.json'].pools=[];
  for(const [file,value] of Object.entries(fixture))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  child=spawn(node,[path.join(project,'server.js')],{env:{...env,ELECTRON_RUN_AS_NODE:'1',TZ:'Asia/Shanghai',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,[selectedAgent.env]:cli,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server startup failed: '+logs)),15000);
    child.stdout.on('data',chunk=>{logs+=chunk.toString();if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});
    child.stderr.on('data',chunk=>{logs+=chunk.toString();});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs));});
  });
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)browserErrors.push(message);});
  window.webContents.on('render-process-gone',(_event,details)=>browserErrors.push('Renderer exited: '+details.reason));
  const localD3=process.env.MEMO_D3_TEST_FILE;
  const allowedStatic=new Set(['https://d3js.org/d3.v7.min.js','https://cdn.jsdelivr.net/npm/marked/marked.min.js']);
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>{
    const local=details.url.startsWith(base+'/');
    const snapshot=local && new URL(details.url).pathname==='/api/ai/task';
    const externalStatic=!localD3 && allowedStatic.has(details.url);
    callback({cancel:snapshot || !(local || externalStatic)});
  });
  await window.loadURL(base+'/');
  if(localD3){assert.ok(fs.existsSync(localD3),'MEMO_D3_TEST_FILE does not exist');await read(fs.readFileSync(localD3,'utf8'));report.graphLibrary={source:'local real D3 library',path:localD3};}
  else report.graphLibrary={source:'official D3 CDN'};
  await until(`agentStatusKnown && settings.agent===${JSON.stringify(agent)} && !document.getElementById('agentSelect').disabled && memos.length===8`);
  assert.equal((await json('/api/ai/status')).configured,true);
  passed('cli-and-isolation','真实 CLI、临时数据库及独立桌面会话',{cli,records:8});

  if(!graphOnly){
  begin('tag-stream-ui','点击标签整理、后台回答增量、锁和结果跳转');
  await read(`document.getElementById('btnTagSuggest').click()`);
  await until(`!document.getElementById('tagSuggestModal').classList.contains('hidden')`);
  await read(`
    window.streamSamples=[];window.streamStart=performance.now();
    window.streamListener=event=>{
      const task=event.detail.task,chars=(task?.messages || []).reduce((n,m)=>n+m.text.length,0);
      if(task?.status==='running' && chars>(window.streamSamples.at(-1)?.chars || 0))window.streamSamples.push({ms:Math.round(performance.now()-window.streamStart),chars});
    };
    window.addEventListener('cc-task-update',window.streamListener);
    document.getElementById('tagSuggestGenBtn').click();
  `);
  await until(`window._ccLatestTask?.status==='running' && _ccLatestTask.messages.some(m=>m.text.length>0)`,timeoutMs,{task:true});
  const partial=await read(`(async()=>{
    const before=_ccLatestTask.messages.map(m=>({...m}));
    const running=_ccLatestTask.status==='running';
    const locked=document.getElementById('agentSelect').disabled;
    document.getElementById('tagSuggestClose').click();
    const closed=document.getElementById('tagSuggestModal').classList.contains('hidden');
    const stillLocked=document.getElementById('agentSelect').disabled;
    const blocked=!(await window.openAITaskDestination());
    const after=_ccLatestTask.messages;
    const preserved=before.length>0 && before.every(previous=>{
      const current=after.find(message=>message.id===previous.id);
      return previous.id && current && current.text.startsWith(previous.text);
    });
    return {running,locked,closed,stillLocked,blocked,buttonHidden:document.querySelector('#tagSuggestGenBtn + [data-ai-task-details]').hidden,preserved,noTranscript:!document.getElementById('aiTaskModal')};
  })()`);
  assert.ok(partial.running,'The first reply text must arrive before completion');
  for(const [key,value] of Object.entries(partial))assert.equal(value,true,'Partial task check failed: '+key);
  await capture('tag-stream-partial.png');
  await until(`window._ccLatestTask?.status==='completed' && !document.getElementById('tagSuggestGenBtn').disabled && !document.getElementById('agentSelect').disabled`,timeoutMs,{task:true});
  await until(`!document.querySelector('#tagSuggestGenBtn + [data-ai-task-details]').hidden`);
  await read(`document.querySelector('#tagSuggestGenBtn + [data-ai-task-details]').click()`);
  await until(`!document.getElementById('tagSuggestModal').classList.contains('hidden')`);
  const samples=await read('window.streamSamples');report.streamSamples=samples;
  assert.ok(samples.length>=3,'Expected at least 3 retained text increases while running with snapshot polling blocked: '+JSON.stringify(samples));
  const tagState=await read(`({history:tagSuggestHistory.length,renderedHistory:document.querySelectorAll('#tagSuggestHistory .tag-summary-item').length,answer:_ccLatestTask.messages.at(-1)?.text || ''})`);
  assert.equal(tagState.history,1);assert.equal(tagState.renderedHistory,1);
  const parsed=JSON.parse(tagState.answer.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,''));assert.ok(Array.isArray(parsed));
  const tagSaved=await json('/api/cc/suggestions');assert.equal(tagSaved.tagSuggestionHistory.length,1);assert.equal(tagSaved.tagSuggestionHistory[0].coverage.processedCount,8);
  await capture('tag-stream-completed.png');
  passed('tag-stream-ui','标签整理真实回答留存、锁、结果跳转、校验和历史保存',{...partial,retainedGrowthSamples:samples.length,firstReplyMs:samples[0].ms,suggestions:parsed.length,processedCount:8,history:1});
  await read(`window.removeEventListener('cc-task-update',window.streamListener);document.getElementById('tagSuggestClose').click()`);

  begin('daily-digest-ui','点击生成今日摘要并展开、保存');
  assert.equal(await read(`document.getElementById('digestBanner').classList.contains('hidden')`),false);
  await read(`document.getElementById('digestRegenBtn').click()`);await waitButtonFinished('digestRegenBtn');
  const daily=await json('/api/cc/suggestions');assert.ok(daily.dailyDigest.summary);assert.notEqual(daily.dailyDigest.summary,placeholder);assert.equal(daily.dailyDigest.coverage.processedCount,8);
  await read(`document.getElementById('digestToggle').click()`);assert.equal(await read(`document.getElementById('digestBanner').classList.contains('digest-collapsed')`),true);
  await read(`document.getElementById('digestToggle').click()`);assert.equal(await read(`document.getElementById('digestBanner').classList.contains('digest-collapsed')`),false);
  assert.equal(await read(`document.getElementById('digestText').textContent.length>0`),true);
  await capture('daily-digest-expanded.png');passed('daily-digest-ui','今日摘要真实点击生成、折叠展开和保存',{processedCount:8,date:daily.dailyDigest.date});
  }

  begin('graph-ui','点击生成图谱及查看已保存历史');
  assert.equal(await read(`typeof d3!=='undefined'`),true,'The real D3 library must load for graphical acceptance');
  await read(`document.getElementById('btnTagGraph').click()`);await until(`!document.getElementById('graphModal').classList.contains('hidden')`);
  await read(`document.getElementById('graphRegenBtn').click()`);await waitButtonFinished('graphRegenBtn');
  const graphs=(await json('/api/cc/suggestions')).graphHistory;assert.equal(graphs.length,1);assert.equal(graphs[0].coverage.processedCount,8);assert.ok(graphs[0].nodes.length);
  await until(`document.querySelectorAll('#graphContainer .graph-node').length>0 && document.getElementById('graphNavInfo').textContent==='1 / 1'`);
  assert.ok(await read(`document.getElementById('graphSummaryPanel').textContent.trim().length>0`));
  if(process.env.MEMO_GRAPH_VISUAL_SETTLE_MS){
    await delay(Number(process.env.MEMO_GRAPH_VISUAL_SETTLE_MS));
    report.settledVisualReview=await read(`(()=>{
      const labels=[...document.querySelectorAll('#graphContainer .graph-node text,#graphContainer .graph-cluster-label')].map((node,index)=>{const r=node.getBoundingClientRect();return {index,text:node.textContent,x:r.x,y:r.y,width:r.width,height:r.height};});
      const overlaps=[];
      for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
        const a=labels[i],b=labels[j],w=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),h=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
        if(w>3&&h>3)overlaps.push({a:a.text,b:b.text,width:w,height:h});
      }
      return {labels,overlaps};
    })()`);
    fs.writeFileSync(path.join(evidence,'real-generated-graph.json'),JSON.stringify(graphs[0],null,2)+'\n');
    await capture('graph-settled.png');
  }
  await capture('graph-generated.png');
  const relationDisplay=await read(`(()=>{
    const labels=[...document.querySelectorAll('#graphContainer .graph-link-label')];
    const lines=[...document.querySelectorAll('#graphContainer .graph-link')];
    const connectedNode=[...document.querySelectorAll('#graphContainer .graph-node')].find(node=>lines.some(line=>[line.__data__.source.id,line.__data__.target.id].includes(node.__data__.id)));
    window.acceptanceGraphNode=connectedNode;
    return {labels:labels.length,defaultVisible:labels.filter(label=>getComputedStyle(label).opacity!=='0').length,maxCodepoints:Math.max(0,...labels.map(label=>Array.from(label.textContent).length)),fullRelationsRetained:lines.every(line=>line.querySelector('title')?.textContent.endsWith(line.__data__.relation)),connectedNode:Boolean(connectedNode)};
  })()`);
  assert.ok(relationDisplay.labels>0,'The real graph must contain relationships for hover acceptance');
  assert.equal(relationDisplay.defaultVisible,0);assert.ok(relationDisplay.maxCodepoints<=13);assert.equal(relationDisplay.fullRelationsRetained,true);assert.equal(relationDisplay.connectedNode,true);
  await read(`window.acceptanceGraphNode.dispatchEvent(new MouseEvent('mouseenter'))`);
  const hovered=await read(`(()=>{const id=window.acceptanceGraphNode.__data__.id;const visible=[...document.querySelectorAll('#graphContainer .graph-link-label.is-visible')];return {count:visible.length,onlyAdjacent:visible.every(label=>[label.__data__.source.id,label.__data__.target.id].includes(id))};})()`);
  assert.ok(hovered.count>0);assert.equal(hovered.onlyAdjacent,true);await capture('graph-relations-hover.png');
  await read(`window.acceptanceGraphNode.dispatchEvent(new MouseEvent('mouseleave'))`);
  assert.equal(await read(`document.querySelectorAll('#graphContainer .graph-link-label.is-visible').length`),0);
  // A hidden macOS Electron window changes activeElement without delivering DOM focus.
  // Briefly show the isolated test window so this checks the real focus handler.
  window.showInactive();
  window.focus();window.webContents.focus();
  await until(`document.hasFocus()`);
  await read(`window.acceptanceGraphNode.focus()`);assert.ok(await read(`document.activeElement===window.acceptanceGraphNode && document.querySelectorAll('#graphContainer .graph-link-label.is-visible').length>0`));
  await read(`window.acceptanceGraphNode.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));window.acceptanceGraphNode.blur()`);
  assert.ok(await read(`window.acceptanceGraphNode.classList.contains('selected') && document.querySelectorAll('#graphContainer .graph-link-label.is-visible').length>0`));
  await capture('graph-relations-selected.png');
  window.hide();
  await read(`document.getElementById('graphClose').click();document.getElementById('btnTagGraph').click()`);
  await until(`!document.getElementById('graphModal').classList.contains('hidden') && graphHistory.length===1 && document.querySelectorAll('#graphContainer .graph-node').length>0`);
  assert.equal(await read('graphHistory[0].id'),graphs[0].id);
  await capture('graph-history.png');passed('graph-ui','图谱真实点击生成、图形展示、关系悬停/焦点/选中和关闭重开历史',{processedCount:8,nodes:graphs[0].nodes.length,historyId:graphs[0].id,relationDisplay,hovered});
  await read(`document.getElementById('graphClose').click()`);

  if(!graphOnly){
  begin('weekly-tag-range-ui','选择单个标签生成周总结并校验保存范围');
  await read(`document.getElementById('btnWeeklyDigest').click()`);await until(`!document.getElementById('weeklyModal').classList.contains('hidden') && !!document.querySelector('#weeklyTagPicker [data-tag="reading"]')`);
  await read(`document.querySelector('#weeklyTagPicker [data-tag="reading"]').click()`);
  assert.deepEqual(await read('weeklySelectedTags'),['reading']);await capture('weekly-tag-selected.png');
  await read(`document.getElementById('weeklyGenBtn').click()`);await waitButtonFinished('weeklyGenBtn');
  const weekly=(await json('/api/cc/suggestions')).weeklyDigests;assert.equal(weekly.length,1);assert.deepEqual(weekly[0].tags,['reading']);assert.deepEqual(weekly[0].coverage.tags,['reading']);assert.equal(weekly[0].coverage.processedCount,1);assert.equal(weekly[0].tagTrends.reading,1);
  await until(`document.querySelectorAll('#weeklyHistory .tag-summary-item').length===1`);
  assert.ok(await read(`document.getElementById('weeklyHistory').textContent.includes('reading')`));
  await read(`document.querySelector('#weeklyHistory .summary-item-actions button').click()`);
  assert.ok(await read(`document.querySelector('#weeklyHistory .tag-summary-item-content:not(.collapsed-content)')?.textContent.trim().length>0`));
  await capture('weekly-tag-summary.png');
  await read(`document.getElementById('weeklyClose').click();document.getElementById('btnWeeklyDigest').click()`);
  await until(`!document.getElementById('weeklyModal').classList.contains('hidden') && weeklyHistory.length===1`);
  assert.deepEqual(await read('weeklyHistory[0].tags'),['reading']);
  passed('weekly-tag-range-ui','单标签周总结真实点击生成、展开和历史范围保存',{tags:weekly[0].tags,processedCount:1,week:weekly[0].week,history:1});
  }
  report.success=true;report.elapsedMs=Date.now()-new Date(report.startedAt).getTime();persist();
}
app.whenReady().then(run).catch(async error=>{
  report.success=false;report.error={message:error.message,stack:error.stack};
  if(currentCheck && !report.checks.some(check=>check.id===currentCheck.id))report.checks.push({...currentCheck,status:'failed',error:{message:error.message,stack:error.stack}});
  console.error(error.stack);process.exitCode=1;
  try{if(window && !window.isDestroyed())report.failureUi=await read(`({taskStatus:window._ccLatestTask?.status,taskStage:window._ccLatestTask?.error || window._ccLatestTask?.stage,toast:document.querySelector('.toast')?.textContent})`);await capture('failed.png');}catch(captureError){report.captureError=captureError.message;}
}).finally(async()=>{
  if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  report.finishedAt=new Date().toISOString();report.browserErrors=browserErrors;delete report.currentCheck;persist();
  fs.writeFileSync(path.join(evidence,graphOnly ? 'graph-retest-server.log' : 'server.log'),logs);fs.rmSync(root,{recursive:true,force:true});
  console.log(JSON.stringify({realCliUiAcceptance:true,agent,graphOnly,success:report.success,passed:report.checks.filter(check=>check.status==='passed').length,failed:report.checks.filter(check=>check.status==='failed').length,report:path.join(evidence,resultName)}));
  window?.destroy();
  app.exit(process.exitCode || 0);
});
