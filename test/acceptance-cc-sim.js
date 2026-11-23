// Explicit CC acceptance exercise using only a deterministic fake Claude CLI.
// It tests Memo's real HTTP service and storage, not Claude authentication/model quality.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const AdmZip=require('adm-zip');
const {invokeAgent}=require('../agents');
const project=path.resolve(__dirname,'..');
const evidence=path.join(__dirname,'acceptance-evidence','simulation');
fs.mkdirSync(evidence,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-acceptance-cc-'));
const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
const capture=path.join(root,'model-calls.jsonl'),mode=path.join(root,'mode');
const fake=path.join(root,'fake-claude'),quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
fs.writeFileSync(fake,`#!/bin/sh\nexport MEMO_FAKE_AGENT=cc\nexec ${quote(process.execPath)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
const env={...process.env,TZ:'Asia/Shanghai',MEMO_ELECTRON:'1',MEMO_CONFIG_DIR:root,MEMO_DATA_DIR:dataDir,CLAUDE_CLI:fake,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_INVALID_FILE:mode};
const now=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const defaults=require('../storage/defaults')();
defaults['settings.json'].agent='cc';defaults['settings.json'].tags=['阅读','书籍','工作'];
defaults['memos.json'].memos=[
  {id:'acceptance-reading-1',content:'虚构验收：阅读一本关于习惯的书。',tags:['阅读'],createdAt:now.toISOString(),updatedAt:now.toISOString()},
  {id:'acceptance-reading-2',content:'虚构验收：为读书笔记整理主题。',tags:['阅读','书籍'],createdAt:now.toISOString(),updatedAt:now.toISOString()},
  {id:'acceptance-work-1',content:'虚构验收：完成项目复盘。',tags:['工作'],createdAt:now.toISOString(),updatedAt:now.toISOString()},
  {id:'acceptance-work-2',content:'虚构验收：明天梳理一个小任务。',tags:['工作'],createdAt:now.toISOString(),updatedAt:now.toISOString()}
];
defaults['habit_pools.json'].pools=[];
for(const [file,value] of Object.entries(defaults))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
const report={agent:'cc',mode:'simulation',realCli:false,realModel:false,fictionalData:true,startedAt:new Date().toISOString(),rows:[]};
let child,base,port,logs='',sequence=0,wishPurpose,wishEffort,wishBody,wishPool;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function step(id,label,run){const started=Date.now();try{const details=await run();report.rows.push({id,label,status:'passed',mode:'simulation',durationMs:Date.now()-started,details});console.log('PASS '+id+' '+label);}catch(error){report.rows.push({id,label,status:'failed',mode:'simulation',durationMs:Date.now()-started,error:error.message,stack:error.stack});console.error('FAIL '+id+' '+error.stack);}}
function calls(){return fs.existsSync(capture) ? fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];}
async function stop(){if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
async function start(){
  child=spawn(process.execPath,['--require',path.join(__dirname,'cron-driver.js'),path.join(project,'server.js')],{env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe','ipc']});
  let startupOutput='';
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server startup timeout: '+logs)),10000);
    const receive=data=>{logs+=data.toString();startupOutput+=data.toString();if(startupOutput.includes('Memo server running')){clearTimeout(timeout);resolve();}};
    child.stdout.on('data',receive);child.stderr.on('data',data=>{logs+=data.toString();});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exit '+code+': '+logs));});
  });
}
async function request(route,{method='GET',body,status=200,headers={}}={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
const ask=(action,params={},status=200)=>request('/api/cc/ask',{method:'POST',body:{action,params},status});
async function drive(index){return new Promise((resolve,reject)=>{
  const id=++sequence,timeout=setTimeout(()=>reject(new Error('Cron callback timeout')),10000);
  const receive=message=>{if(message.id!==id)return;clearTimeout(timeout);child.off('message',receive);message.ok ? resolve() : reject(new Error(message.error));};
  child.on('message',receive);child.send({id,action:'run',index});
});}
async function wish(body){
  const response=await fetch(base+'/api/habit/wish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);
  const text=await response.text();
  const frames=text.split('\n\n').map(frame=>({event:/^event: (.+)$/m.exec(frame)?.[1],text:/^data: (.+)$/m.exec(frame)?.[1]})).filter(frame=>frame.text).map(frame=>({...frame,data:JSON.parse(frame.text)}));
  assert.doesNotMatch(text,/PRIVATE_THINKING/);
  assert.equal(frames.some(frame=>frame.event==='error'),false,text);
  const result=frames.find(frame=>frame.event==='result')?.data;assert.ok(result);
  return {result,questionLengths:[...new Set(frames.filter(frame=>frame.event==='question').map(frame=>frame.data.text.length))]};
}
async function main(){
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  await start();
  await step('cc-selection','CC 模拟 CLI 检测及选中状态',async()=>{const status=await request('/api/ai/status');assert.equal(status.agent,'cc');assert.equal(status.configured,true);return {configured:true};});
  await step('tag-suggestions','整理标签、来源校验及历史保存',async()=>{const data=await ask('tag-suggestions');assert.ok(data.suggestions.length);assert.equal(data.coverage.processedCount,4);const saved=await request('/api/cc/suggestions');assert.ok(saved.tagSuggestionHistory.length);return {suggestions:data.suggestions.length,processedCount:4,modelTask:calls().at(-1).task};});
  await step('graph','全部便签图谱生成及历史保存',async()=>{const data=await ask('graph');assert.equal(data.graph.coverage.processedCount,4);assert.ok(data.graph.nodes.length);assert.ok((await request('/api/cc/suggestions')).graphHistory.some(item=>item.id===data.graph.id));return {nodes:data.graph.nodes.length,edges:data.graph.edges.length,processedCount:4};});
  await step('graph-filter','图谱标签与日期范围筛选',async()=>{const data=await ask('graph',{tags:['阅读'],from:today,to:today});assert.equal(data.graph.coverage.processedCount,2);assert.ok(data.graph.nodes.every(node=>node.memoIds.every(id=>id.startsWith('acceptance-reading'))));return {from:today,to:today,processedCount:2};});
  await step('daily-digest','今日摘要、服务端日期、标签计数及保存',async()=>{const data=await ask('daily-digest');assert.equal(data.digest.coverage.processedCount,4);assert.equal(data.digest.date,today);assert.equal(data.digest.tagTrends['工作'],2);assert.ok(data.digest.summary);assert.equal((await request('/api/cc/suggestions')).dailyDigest.summary,data.digest.summary);return {processedCount:4,date:data.digest.date};});
  await step('weekly-digest','本周总结、周边界及历史保存',async()=>{const data=await ask('weekly-digest');assert.equal(data.digest.coverage.processedCount,4);assert.match(data.digest.week,/^\d{4}-W\d{2}$/);assert.ok((await request('/api/cc/suggestions')).weeklyDigests.length);return {processedCount:4,week:data.digest.week};});
  await step('scheduled-daily','定时今日摘要回调调用 CC 并保存',async()=>{const count=calls().length;await drive(0);assert.equal(calls().length,count+1);assert.equal(calls().at(-1).task,'daily-digest');assert.equal(calls().at(-1).agent,'cc');return {cronIndex:0,modelTask:'daily-digest'};});
  await step('scheduled-weekly','定时本周总结回调调用 CC 并保存',async()=>{const count=calls().length;await drive(1);assert.equal(calls().length,count+1);assert.equal(calls().at(-1).task,'weekly-digest');assert.equal(calls().at(-1).agent,'cc');return {cronIndex:1,modelTask:'weekly-digest'};});
  await step('book-habit-pool','上传书籍 ZIP 生成 30 张习惯卡',async()=>{const zip=new AdmZip();zip.addFile('fictional-book.txt',Buffer.from('虚构验收书籍：每天从很小的行动开始，安排一次阅读，记录一次想法。'));const form=new FormData();form.append('zipFile',new Blob([zip.toBuffer()]),'fictional-book.zip');const response=await fetch(base+'/api/habit/pools/generate',{method:'POST',body:form});assert.equal(response.status,200);const data=await response.json();assert.equal(data.pool.habits.length,30);assert.ok((await request('/api/habit/pools')).pools.some(pool=>pool.id===data.pool.id));assert.deepEqual(fs.readdirSync(path.join(dataDir,'habit_upload')),[]);return {cards:30,saved:true,uploadCleaned:true};});
  await step('wish-purpose','愿望目的提问实时增量及三个选项',async()=>{const data=await wish({stage:'purpose',wish:'我想开始画画'});assert.equal(data.result.options.length,3);assert.ok(data.questionLengths.length>2);wishPurpose='希望和朋友一起享受画画';return {options:3,questionUpdates:data.questionLengths.length};});
  await step('wish-effort','愿望投入方式提问及前轮回答传递',async()=>{const data=await wish({stage:'effort',wish:'我想开始画画',purpose:wishPurpose});assert.equal(data.result.options.length,3);assert.ok(data.questionLengths.length>2);assert.match(data.result.question,/朋友/);wishEffort='每天五分钟，轻松尝试';return {options:3,questionUpdates:data.questionLengths.length,contextPreserved:true};});
  await step('wish-pool','愿望生成 30 张卡、保存及重复提交幂等',async()=>{wishBody={stage:'generate',wish:'我想开始画画',purpose:wishPurpose,effort:wishEffort,requestId:randomUUID()};const data=await wish(wishBody);wishPool=data.result.pool;assert.equal(wishPool.habits.length,30);assert.equal(wishPool.wishContext.effort,wishEffort);const count=calls().length;const repeated=await request('/api/habit/wish',{method:'POST',body:wishBody});assert.equal(repeated.pool.id,wishPool.id);assert.equal(calls().length,count);const draw=await request('/api/habit/draw',{method:'POST',body:{poolId:wishPool.id}});assert.ok(draw.log.habit);return {cards:30,idempotent:true,draw:true};});
  await step('stream-reconnect-lock','回答流、断线重连、任务锁及最终快照',async()=>{
    fs.writeFileSync(mode,'stream-slow');const controller=new AbortController();const response=await fetch(base+'/api/ai/events',{signal:controller.signal});const reader=response.body.getReader(),decoder=new TextDecoder();let frames='';
    const collecting=(async()=>{try{while(true){const part=await reader.read();if(part.done)break;frames+=decoder.decode(part.value,{stream:true});}}catch(error){if(error.name!=='AbortError')throw error;}})();
    const generating=ask('graph');for(let i=0;i<300 && !frames.includes('"type":"delta"');i++)await pause(10);assert.match(frames,/"type":"delta"/);
    assert.equal((await request('/api/ai/status')).busy,true);await request('/api/settings',{method:'PUT',body:{agent:'codex'},status:409});await ask('graph',{},409);
    controller.abort();await collecting;
    const reopenedController=new AbortController();const reopened=await fetch(base+'/api/ai/events',{signal:reopenedController.signal});const second=reopened.body.getReader();let replay='';while(!replay.includes('"messages":[')){const part=await second.read();assert.equal(part.done,false);replay+=decoder.decode(part.value,{stream:true});}assert.match(replay,/"status":"running"/);await generating;reopenedController.abort();await second.cancel().catch(()=>{});
    const task=(await request('/api/ai/task')).task;assert.equal(task.status,'completed');assert.doesNotMatch(JSON.stringify(task),/PRIVATE_THINKING/);fs.rmSync(mode);return {streamed:true,reconnected:true,busySwitchDenied:true,parallelTaskDenied:true,completedSnapshot:true};
  });
  await step('invalid-output-recovery','无效 JSON 不覆盖历史、释放锁并可重试',async()=>{const before=(await request('/api/cc/suggestions')).graphHistory.length;fs.writeFileSync(mode,'graph');await ask('graph',{},400);assert.equal((await request('/api/cc/suggestions')).graphHistory.length,before);assert.equal((await request('/api/ai/status')).busy,false);fs.rmSync(mode);await ask('graph');assert.equal((await request('/api/cc/suggestions')).graphHistory.length,before+1);return {historyPreserved:true,lockReleased:true,retrySucceeded:true};});
  await step('auth-failure','模拟登录失败不保存部分结果',async()=>{const before=(await request('/api/cc/suggestions')).graphHistory.length;fs.writeFileSync(mode,'partial-failure');const data=await ask('graph',{},400);assert.match(data.error,/unauthorized|login|AGENT_AUTH|登录/i);assert.equal((await request('/api/cc/suggestions')).graphHistory.length,before);assert.equal((await request('/api/ai/status')).busy,false);fs.rmSync(mode);return {errorRecognized:true,partialResultNotSaved:true};});
  await step('missing-cli','缺失 CLI 检测、提示及恢复',async()=>{fs.renameSync(fake,fake+'.saved');try{assert.equal((await request('/api/ai/status')).configured,false);assert.match((await ask('graph',{},400)).error,/AGENT_CLI_MISSING:cc/);assert.equal((await request('/api/ai/status')).busy,false);}finally{fs.renameSync(fake+'.saved',fake);}assert.equal((await request('/api/ai/status')).configured,true);return {missingDetected:true,recovered:true};});
  await step('timeout','模拟 CLI 超时终止及之后恢复',async()=>{fs.writeFileSync(mode,'hang');await assert.rejects(invokeAgent('cc','fictional book',{cwd:dataDir,configDir:root,env,timeoutMs:350}),/超时/);fs.rmSync(mode);return {timeoutRejected:true};});
  await step('history-delete','AI 图谱和周总结历史删除',async()=>{const before=await request('/api/cc/suggestions');await request('/api/cc/graph/'+before.graphHistory.at(-1).id,{method:'DELETE'});await request('/api/cc/weekly-digest/0',{method:'DELETE'});const after=await request('/api/cc/suggestions');assert.equal(after.graphHistory.length,before.graphHistory.length-1);assert.equal(after.weeklyDigests.length,before.weeklyDigests.length-1);return {graphHistoryDeleted:true,weeklyHistoryDeleted:true};});
  await step('restart-persistence','重启后保留助手、摘要、图谱与卡池',async()=>{const before=await request('/api/cc/suggestions'),pools=await request('/api/habit/pools');await stop();logs+='\n--- restart ---\n';await start();assert.equal((await request('/api/ai/status')).agent,'cc');const after=await request('/api/cc/suggestions');assert.deepEqual(after,before);assert.deepEqual(await request('/api/habit/pools'),pools);return {selectedAgent:'cc',savedPools:pools.pools.length,historyPreserved:true};});
  const modelCalls=calls();assert.ok(modelCalls.length);assert.ok(modelCalls.every(call=>call.agent==='cc'));
  report.modelCallCount=modelCalls.length;report.modelTasks=[...new Set(modelCalls.map(call=>call.task))];
  fs.copyFileSync(capture,path.join(evidence,'cc-model-calls.jsonl'));
}
main().catch(error=>{report.fatalError=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  await stop();report.finishedAt=new Date().toISOString();report.passed=report.rows.filter(row=>row.status==='passed').length;report.failed=report.rows.filter(row=>row.status==='failed').length;
  if(report.failed || report.fatalError)process.exitCode=1;
  fs.writeFileSync(path.join(evidence,'cc-result.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(evidence,'cc-server.log'),logs);fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({ccSimulation:true,passed:report.passed,failed:report.failed,report:path.join(evidence,'cc-result.json')}));
});
