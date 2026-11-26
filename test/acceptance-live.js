// Full acceptance run against an isolated Memo server. Real runs use installed,
// logged-in CLIs; simulation is explicitly labelled and never substitutes for one.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {randomUUID}=require('node:crypto'),AdmZip=require('adm-zip');
const {resolveCli,getSelectableAgent}=require('../agents'),{localDate,periodFor}=require('../tasks/dates');
const project=path.resolve(__dirname,'..');
const agent=process.env.MEMO_TEST_AGENT || 'codex';
getSelectableAgent(agent);
const simulation=process.env.MEMO_ACCEPTANCE_MODE==='simulation';
const commonOnly=process.env.MEMO_ACCEPTANCE_PHASE==='common';
const onlyCases=new Set((process.env.MEMO_ACCEPTANCE_ONLY || '').split(',').filter(Boolean));
const out=path.resolve(process.env.MEMO_ACCEPTANCE_OUT || path.join(__dirname,'acceptance-evidence','live'));
fs.mkdirSync(out,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-acceptance-'+agent+'-'));
const configDir=path.join(root,'config'),dataDir=path.join(root,'data');
fs.mkdirSync(configDir);fs.mkdirSync(dataDir);
let env={...process.env},child,base,port,logs='',sequence=0,authFailure=null;
const cleanups=[];
if(simulation)env={...env,...require('./agent-fixture').fixture({after:fn=>cleanups.push(fn)}).env};
else for(const key of Object.keys(env))if(key.startsWith('MEMO_FAKE_'))delete env[key];
const report={agent,mode:simulation?'simulation':'real',phase:commonOnly?'common':'all',...(onlyCases.size?{onlyCases:[...onlyCases]}:{}),startedAt:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cases:[],syntheticData:true};
const filename=path.join(out,agent+(simulation?'-simulation':'')+(onlyCases.size?'-retest':'')+'.json');
function save(){fs.writeFileSync(filename,JSON.stringify(report,null,2));fs.writeFileSync(filename.replace(/\.json$/,'.server.log'),logs);}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForUploadCleanup(directory) {
  const started=Date.now(),initialEntries=fs.readdirSync(directory);
  let entries=initialEntries;
  while(entries.length && Date.now()-started<2000) {
    await delay(25);entries=fs.readdirSync(directory);
  }
  assert.deepEqual(entries,[],'Upload temporary files must be cleaned after the response');
  return {initialEntries,cleanupWaitMs:Date.now()-started};
}
async function check(id,name,scope,work) {
  if(scope==='ai' && onlyCases.size && !onlyCases.has(id))return;
  if(simulation && scope==='ai')name=name.replace(/^真实\s*/,'模拟');
  const row={id,name,scope,status:'running',startedAt:new Date().toISOString()};report.cases.push(row);save();
  if(scope==='ai' && (commonOnly || authFailure)) {
    row.status='blocked';row.detail=authFailure || process.env.MEMO_ACCEPTANCE_BLOCK_REASON || '账号尚未登录；只执行通用功能，等待登录后重跑真实 CLI。';save();return;
  }
  const start=Date.now();console.log(JSON.stringify({agent,mode:report.mode,test:id,name,status:'running'}));
  try {row.evidence=await work() || {};row.status='passed';}
  catch(error) {
    row.status='failed';row.detail=error.message;
    if(scope==='ai' && /AGENT_AUTH|authentication|not logged|unauthorized|登录/i.test(error.message)){authFailure=error.message;row.status='blocked';}
    console.error(JSON.stringify({agent,test:id,status:row.status,error:error.message}));
  }
  row.elapsedMs=Date.now()-start;row.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({agent,test:id,status:row.status,elapsedMs:row.elapsedMs}));
}
async function request(route,{method='GET',body,status=200,headers={}}={}) {
  const response=await fetch(base+route,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(660000)});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value).slice(0,2000));return value;
}
const put=(route,body)=>request(route,{method:'PUT',body});
const post=(route,body,headers)=>request(route,{method:'POST',body,headers});
const remove=route=>request(route,{method:'DELETE'});
const storageHeaders={'X-Memo-Storage':'1'};
async function start() {
  child=spawn(process.execPath,['--require',path.join(__dirname,'cron-driver.js'),path.join(project,'server.js')],{env:{...env,MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:configDir,PORT:String(port)},stdio:['ignore','pipe','pipe','ipc']});
  child.stderr.on('data',data=>{logs+=data;});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server startup timeout: '+logs.slice(-2000))),10000);
    child.stdout.on('data',data=>{logs+=data;if(String(data).includes('Memo server running')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs.slice(-2000)));});
  });
}
async function stop(){if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
function drive(action,index,now){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{child.off('message',receive);reject(new Error('Scheduled task timeout'));},650000);
  const receive=row=>{if(row.id!==id)return;clearTimeout(timer);child.off('message',receive);row.ok?resolve(row.result):reject(new Error(row.error));};
  child.on('message',receive);child.send({id,action,index,now});
});}
function seed() {
  const fixture=require('../storage/defaults')(),now=new Date(),yesterday=new Date(now),old=new Date(now);yesterday.setDate(now.getDate()-1);old.setDate(now.getDate()-14);
  const themes=[['阅读','读书','睡前读十分钟虚构图书，记下一个新想法'],['运动','锻炼','散步十五分钟，观察呼吸和路边的树'],['生活','整理','收好桌上的三件物品，给明天留出空间']];
  fixture['settings.json'].agent=agent;fixture['settings.json'].tags=themes.flatMap(theme=>theme.slice(0,2)).concat('空标签');
  fixture['memos.json'].memos=Array.from({length:103},(_,i)=>{const theme=themes[i%themes.length],date=i<70?now:i<90?yesterday:old;return {id:'fictional-'+(i+1),content:`虚构验收记录${i+1}：${theme[2]}。这是测试资料。`,tags:theme.slice(0,2),createdAt:date.toISOString()};});
  fixture['ai_suggestions.json']={graphHistory:[],tagSummaries:[],tagSuggestionHistory:[],weeklyDigests:[]};
  fixture['habit_pools.json'].pools=[{id:'fixture-pool',name:'测试小习惯',description:'虚构习惯池',habits:['喝一口水','整理一支笔'],createdAt:now.toISOString()}];
  fixture['habit_log.json'].logs=[];fixture['scheduled_tasks.json']={tasks:[],pending:[]};
  for(const [file,value]of Object.entries(fixture))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  return fixture['memos.json'].memos;
}
async function aiTask(action,params={}){return post('/api/cc/ask',{action,params});}
async function liveGraph() {
  const controller=new AbortController(),stream=await fetch(base+'/api/ai/events',{signal:controller.signal});
  const reader=stream.body.getReader(),decoder=new TextDecoder();let frames='',deltas=0,firstDeltaMs=null;
  const startAt=Date.now();
  const collecting=(async()=>{try{while(true){const part=await reader.read();if(part.done)break;frames+=decoder.decode(part.value,{stream:true});deltas=(frames.match(/"type":"delta"/g)||[]).length;if(deltas&&firstDeltaMs===null)firstDeltaMs=Date.now()-startAt;}}catch(error){if(error.name!=='AbortError')throw error;}})();
  let resolved=false;
  const task=aiTask('graph').finally(()=>{resolved=true;});task.catch(()=>{});
  try {
    let busy;for(let i=0;i<100&&!resolved;i++){busy=await request('/api/ai/status');if(busy.busy)break;await delay(50);}
    assert.equal(busy?.busy,true,'Generation should expose a running task');
    await request('/api/settings',{method:'PUT',body:{agent:agent==='codex'?'codebuddy':'codex'},status:409});
    await request('/api/cc/ask',{method:'POST',body:{action:'graph'},status:409});
    await request('/api/storage/restore',{method:'POST',body:{name:'not-needed.sqlite'},headers:storageHeaders,status:409});
    const result=await task;
    await delay(50);
    const snapshot=await request('/api/ai/task');
    assert.equal(snapshot.task.status,'completed');assert.ok(snapshot.task.messages.length);
    assert.ok(deltas>0,'Real reply deltas must arrive');
    return {result,metrics:{deltaCount:deltas,firstDeltaMs,elapsedMs:Date.now()-startAt,busyLock:true,restoreLock:true,validatedAndSaved:true,taskSnapshot:true}};
  }finally{controller.abort();await collecting;}
}
async function wishTurn(body) {
  const response=await fetch(base+'/api/habit/wish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(660000)});
  if(response.status!==200)throw new Error(JSON.stringify(await response.json()));
  if(!response.headers.get('content-type').includes('text/event-stream'))return {result:await response.json(),growths:0};
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result;const lengths=[];
  while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let p;while((p=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,p);buffer=buffer.slice(p+2);const event=/^event: (.+)$/m.exec(frame)?.[1],data=/^data: (.+)$/m.exec(frame)?.[1];if(!data)continue;const value=JSON.parse(data);if(event==='error')throw new Error(value.error);if(event==='question'&&lengths.at(-1)!==value.text.length)lengths.push(value.text.length);if(event==='result')result=value;}}
  assert.ok(result,'Expected a completed guided turn');return {result,growths:lengths.length,lengths};
}
async function main() {
  assert.ok(['codex','trae','codebuddy','cc'].includes(agent));assert.ok(agent!=='cc'||simulation,'CC requires explicit simulation mode in this environment');
  report.cli=resolveCli(agent,{env,configDir});assert.ok(report.cli,'CLI executable missing');
  const records=seed(),probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  await start();let memo,newTag='临时验收标签',draw,backup,snapshotBytes,graph,tagResult,daily,weekly,bookPool,purpose,effort,wishBody,wishPool;
  await check('startup','启动、助手自动识别与设置读取','common',async()=>{const status=await request('/api/ai/status');assert.equal(status.agent,agent);assert.equal(status.configured,true);assert.equal((await request('/api/settings')).agent,agent);return {configured:true,selected:agent,seedRecords:records.length};});
  await check('memo_create','新增中文、emoji及多标签便签','common',async()=>{memo=await post('/api/memos',{content:'验收专用 你好 🌱 SQLite 唯一短语',tags:['阅读','读书']});assert.ok(memo.id);assert.equal((await request('/api/memos')).length,104);});
  await check('memo_edit','编辑便签内容与标签','common',async()=>{await put('/api/memos/'+memo.id,{content:'验收专用 编辑后的记录 🌱 SQLite',tags:['运动','锻炼']});assert.equal((await request('/api/memos')).find(row=>row.id===memo.id).content,'验收专用 编辑后的记录 🌱 SQLite');});
  await check('memo_pin','置顶及取消置顶','common',async()=>{await put('/api/memos/'+memo.id,{pinned:true});assert.equal((await request('/api/memos'))[0].id,memo.id);await put('/api/memos/'+memo.id,{pinned:false});assert.equal((await request('/api/memos')).find(row=>row.id===memo.id).pinned,false);});
  await check('memo_validation','空白及非文本便签拒绝且不覆盖原文','common',async()=>{await request('/api/memos',{method:'POST',body:{content:'  '},status:400});await request('/api/memos/'+memo.id,{method:'PUT',body:{content:null},status:400});assert.equal((await request('/api/memos')).find(row=>row.id===memo.id).content,'验收专用 编辑后的记录 🌱 SQLite');});
  await check('search_exact','本地精确搜索、大小写与空结果','common',async()=>{for(const word of ['编辑后的','sqlite','ＳＱＬｉｔｅ'])assert.deepEqual((await request('/api/memos?keyword='+encodeURIComponent(word))).map(row=>row.id),[memo.id]);assert.equal((await request('/api/memos?keyword=NoSuchFictionalPhrase')).length,0);});
  await check('search_fuzzy','本地模糊搜索、无序关键词及旧搜索接口','common',async()=>{const query='记录 编辑后';assert.ok((await request('/api/memos?mode=fuzzy&keyword='+encodeURIComponent(query))).some(row=>row.id===memo.id));assert.deepEqual((await post('/api/cc/ask',{action:'search',params:{query:'验收专用'}})).results,[memo.id]);});
  await check('tag_filter','单标签、多标签及搜索组合筛选','common',async()=>{const rows=await request('/api/memos?tags='+encodeURIComponent(JSON.stringify(['运动','锻炼']))+'&keyword='+encodeURIComponent('验收专用'));assert.deepEqual(rows.map(row=>row.id),[memo.id]);assert.ok((await request('/api/memos?tag='+encodeURIComponent('阅读'))).length);});
  await check('tag_create_style','新增标签、emoji与胶带设置','common',async()=>{await post('/api/tags',{tag:newTag,emoji:'🌿'});const s=await request('/api/settings');assert.ok(s.tags.includes(newTag));await put('/api/settings',{tagEmojis:{...s.tagEmojis,[newTag]:'🌱'},tagTapes:{...s.tagTapes,[newTag]:'pink'}});assert.equal((await request('/api/settings')).tagEmojis[newTag],'🌱');});
  await check('tag_rename_order','重命名标签同步便签并保存排序','common',async()=>{await put('/api/memos/'+memo.id,{tags:[newTag]});await put('/api/tags/'+encodeURIComponent(newTag),{newTag:'改名验收标签'});newTag='改名验收标签';assert.deepEqual((await request('/api/memos')).find(row=>row.id===memo.id).tags,[newTag]);const s=await request('/api/settings');await put('/api/settings',{tagOrder:[...s.tags].reverse()});assert.equal((await request('/api/settings')).tagOrder[0],[...s.tags].reverse()[0]);});
  await check('tag_delete_notes','删除标签及其关联测试便签','common',async()=>{await remove('/api/tags/'+encodeURIComponent(newTag));assert.equal((await request('/api/memos')).some(row=>row.id===memo.id),false);assert.equal((await request('/api/memos')).length,103);});
  await check('memo_delete','独立删除便签','common',async()=>{const row=await post('/api/memos',{content:'将被删除的验收便签',tags:[]});await remove('/api/memos/'+row.id);assert.equal((await request('/api/memos')).some(item=>item.id===row.id),false);});
  await check('blind_box','任务盲盒随机选择及标签范围','common',async()=>{const row=await request('/api/memos/random?tags='+encodeURIComponent('阅读'));assert.ok(row.id);assert.ok(row.tags.includes('阅读'));assert.equal(await request('/api/memos/random?tags='+encodeURIComponent('不存在的标签')),null);});
  await check('theme_custom','预设主题、自定义配色保存','common',async()=>{await put('/api/settings',{theme:'mint'});assert.equal((await request('/api/settings')).theme,'mint');const colors={bg:'#f5f0e8',card:'#ffffff',accent:'#8e6650'};await put('/api/settings',{theme:'custom',customColors:colors});assert.deepEqual((await request('/api/settings')).customColors,colors);});
  await check('schedule_settings','日周摘要时间设置、非法时间与任务去重','common',async()=>{await put('/api/settings',{dailyDigestTime:'18:42',weeklyDigestDay:'monday',weeklyDigestTime:'18:43'});const jobs=await drive('jobs');assert.equal(jobs.length,2);await request('/api/settings',{method:'PUT',body:{dailyDigestTime:'99:99'},status:500});assert.equal((await request('/api/settings')).dailyDigestTime,'18:42');});
  await check('pool_edit','卡池列表、改名与编辑习惯','common',async()=>{assert.equal((await request('/api/habit/pools')).pools.length,1);await put('/api/habit/pools/fixture-pool',{name:'改名测试池',habits:['喝一口水','整理一支笔','望一眼窗外']});assert.equal((await request('/api/habit/pools')).pools[0].name,'改名测试池');});
  await check('habit_draw_today','抽取习惯及今日记录','common',async()=>{draw=(await post('/api/habit/draw',{poolId:'fixture-pool'})).log;assert.ok(['喝一口水','整理一支笔','望一眼窗外'].includes(draw.habit));assert.ok((await request('/api/habit/today')).logs.some(row=>row.id===draw.id));});
  await check('habit_complete_calendar','习惯完成、日月历史与打卡日历','common',async()=>{assert.equal((await put('/api/habit/log/'+draw.id+'/complete',{})).completed,true);const [year,month]=draw.date.split('-');assert.equal((await request(`/api/habit/calendar?year=${year}&month=${Number(month)}`)).calendar[draw.date],'completed');assert.ok((await request('/api/habit/log?date='+draw.date)).logs.some(row=>row.id===draw.id));assert.ok((await request('/api/habit/log?month='+draw.date.slice(0,7))).logs.some(row=>row.id===draw.id));});
  await check('pool_delete_history','删除卡池保留原打卡历史、删除记录','common',async()=>{await remove('/api/habit/pools/fixture-pool');assert.equal((await request('/api/habit/log')).logs.find(row=>row.id===draw.id).poolName,'改名测试池');await remove('/api/habit/log/'+draw.id);assert.equal((await request('/api/habit/log')).logs.length,0);});
  await check('habit_invalid','缺失卡池、空选择及非法日历输入','common',async()=>{await request('/api/habit/draw',{method:'POST',body:{},status:400});await request('/api/habit/draw',{method:'POST',body:{poolId:'missing'},status:404});await request('/api/habit/calendar',{status:400});});
  await check('reminder_crud','创建日期提醒和每日提醒、列表与删除','common',async()=>{for(const body of [{content:'虚构未来提醒',date:'2099-01-01',time:'12:30'},{content:'虚构每日提醒',time:'12:31'}]){const item=await post('/api/scheduled',body);assert.ok((await request('/api/scheduled')).tasks.some(row=>row.id===item.id));await remove('/api/scheduled/'+item.id);}assert.equal((await request('/api/scheduled')).tasks.length,0);});
  await check('reminder_validation','拒绝非法提醒时间、日期及空内容','common',async()=>{for(const body of [{content:'',time:'12:00'},{content:'test',time:'25:00'},{content:'test',time:'12:00',date:'2026-02-30'}])await request('/api/scheduled',{method:'POST',body,status:400});});
  await check('reminder_delivery','真实提醒回调排队、同分钟去重及单次消费','common',async()=>{const when='2026-11-23T12:05:00+08:00',item=await post('/api/scheduled',{content:'虚构自动提醒',date:'2026-11-23',time:'12:05'});await drive('reminder',undefined,when);await drive('reminder',undefined,when);const pending=(await request('/api/scheduled/pending')).pending;assert.equal(pending.length,1);assert.ok(pending[0].message.includes('虚构自动提醒'));assert.equal((await request('/api/scheduled/pending')).pending.length,0);await remove('/api/scheduled/'+item.id);return {queueAndDeduplication:true,osNotificationBanner:'not covered by API test'};});
  await check('backup_download','立即备份、状态及 SQLite 下载','common',async()=>{backup=await post('/api/storage/backup',{},storageHeaders);const response=await fetch(base+'/api/storage/backups/'+backup.name);assert.equal(response.status,200);snapshotBytes=Buffer.from(await response.arrayBuffer());assert.equal(snapshotBytes.subarray(0,15).toString(),'SQLite format 3');assert.equal((await request('/api/storage/status')).counts.memos,103);});
  await check('export_json','导出全部业务 JSON ZIP','common',async()=>{const response=await fetch(base+'/api/storage/export');const zip=new AdmZip(Buffer.from(await response.arrayBuffer()));for(const name of ['memos.json','settings.json','ai_suggestions.json','habit_pools.json','habit_log.json','scheduled_tasks.json'])assert.ok(zip.getEntry(name),name);assert.equal(JSON.parse(zip.readAsText('memos.json')).memos.length,103);});
  await check('restore_backup','备份列表恢复、数据替换与助手保留','common',async()=>{await post('/api/memos',{content:'恢复时应被移除',tags:[]});await post('/api/storage/restore',{name:backup.name},storageHeaders);assert.equal((await request('/api/memos')).length,103);assert.equal((await request('/api/settings')).agent,agent);});
  await check('restore_upload_invalid','上传恢复、损坏文件拒绝且数据不变','common',async()=>{for(const [bytes,name,status]of [[snapshotBytes,'backup.sqlite',200],[Buffer.from('broken'),'broken.sqlite',400]]){const form=new FormData();form.append('backup',new Blob([bytes]),name);const response=await fetch(base+'/api/storage/restore',{method:'POST',headers:storageHeaders,body:form});assert.equal(response.status,status);}assert.equal((await request('/api/memos')).length,103);});
  await check('local_origin','配置及备份接口的本机来源约束','common',async()=>{await request('/api/storage/backup',{method:'POST',body:{},status:403});const response=await fetch(base+'/api/storage/backup',{method:'POST',headers:{Origin:'https://untrusted.invalid','X-Memo-Storage':'1'}});assert.equal(response.status,403);await request('/api/ai/path',{method:'POST',body:{agent,path:report.cli},status:403});});
  await check('cli_path','手选 CLI 路径生效且服务无需重启','common',async()=>{const pid=child.pid;await post('/api/ai/path',{agent,path:report.cli},{'X-Memo-AI':'1'});assert.equal(child.pid,pid);assert.equal((await request('/api/ai/status')).configured,true);assert.equal(JSON.parse(fs.readFileSync(path.join(configDir,'ai-config.json'))).paths[agent],report.cli);});
  await check('restart_persistence','服务重启后记录、主题、助手及路径保留','common',async()=>{await stop();await start();assert.equal((await request('/api/memos')).length,103);assert.equal((await request('/api/settings')).agent,agent);assert.equal((await request('/api/settings')).theme,'custom');assert.equal((await request('/api/ai/status')).configured,true);});
  await check('empty_scope','空范围图谱拒绝、空摘要本地生成','common',async()=>{await request('/api/cc/ask',{method:'POST',body:{action:'graph',params:{tags:['不存在的标签']}},status:400});const empty=await aiTask('daily-digest',{tags:['不存在的标签']});assert.equal(empty.digest.empty,true);assert.equal(empty.digest.coverage.processedCount,0);});
  await check('graph_full','真实图谱生成、103条分批综合、流式及任务锁','ai',async()=>{const live=await liveGraph();graph=live.result.graph;assert.ok(graph.nodes.length);assert.equal(graph.coverage.processedCount,103);assert.ok(graph.coverage.batchCount>1);assert.ok(graph.clusters.length);assert.ok((await request('/api/cc/suggestions')).graphHistory.some(row=>row.id===graph.id));return {...live.metrics,records:graph.coverage.processedCount,batches:graph.coverage.batchCount,nodes:graph.nodes.length};});
  await check('graph_scope','真实图谱按标签与本地日期筛选、来源引用合法','ai',async()=>{const date=localDate();const result=await aiTask('graph',{tags:['阅读'],from:date,to:date});const expected=records.filter(row=>row.tags.includes('阅读')&&localDate(new Date(row.createdAt))===date);assert.equal(result.graph.coverage.processedCount,expected.length);const ids=new Set(expected.map(row=>row.id));assert.ok(result.graph.nodes.every(node=>node.memoIds.every(id=>ids.has(id))));return {records:expected.length,nodes:result.graph.nodes.length};});
  await check('tag_suggestions','真实标签整理、分批归并及建议历史保存','ai',async()=>{tagResult=await aiTask('tag-suggestions');assert.ok(Array.isArray(tagResult.suggestions));assert.equal(tagResult.coverage.processedCount,103);assert.ok(tagResult.coverage.batchCount>1);assert.ok((await request('/api/cc/suggestions')).tagSuggestionHistory.length);return {suggestions:tagResult.suggestions.length,batches:tagResult.coverage.batchCount};});
  await check('daily_digest','真实今日摘要、昨天今天范围及完整分批','ai',async()=>{daily=(await aiTask('daily-digest')).digest;assert.ok(daily.summary.trim());assert.equal(daily.coverage.processedCount,90);assert.ok(daily.coverage.batchCount>1);assert.equal(daily.date,localDate());assert.equal(daily.tagTrends['阅读'],30);return {summary:daily.summary,records:daily.coverage.processedCount,batches:daily.coverage.batchCount};});
  await check('weekly_digest','真实本周总结、自然周范围及分批统计','ai',async()=>{weekly=(await aiTask('weekly-digest')).digest;const period=periodFor('weekly-digest',new Date()),expected=records.filter(row=>row.createdAt>=period.start&&row.createdAt<period.end&&row.createdAt<=period.asOf);assert.ok(weekly.summary.trim());assert.equal(weekly.week,period.week);assert.equal(weekly.coverage.processedCount,expected.length);assert.ok(weekly.coverage.batchCount>1);return {summary:weekly.summary,records:weekly.coverage.processedCount,batches:weekly.coverage.batchCount,week:weekly.week};});
  await check('daily_scheduled','真实定时日摘要回调使用当前助手并保存','ai',async()=>{const before=(await request('/api/cc/suggestions')).dailyDigest.generatedAt;await delay(5);await drive('run',0);const result=(await request('/api/cc/suggestions')).dailyDigest;assert.notEqual(result.generatedAt,before);assert.equal(result.coverage.processedCount,90);return {generatedAt:result.generatedAt};});
  await check('weekly_scheduled','真实定时周总结回调使用当前助手并保存','ai',async()=>{const before=(await request('/api/cc/suggestions')).weeklyDigests.length;await drive('run',1);const result=(await request('/api/cc/suggestions')).weeklyDigests;assert.equal(result.length,before+1);return {historyCount:result.length};});
  await check('book_pool','真实 ZIP 书籍提炼30张习惯卡、上传清理','ai',async()=>{const zip=new AdmZip();zip.addFile('fictional-book.txt',Buffer.from('虚构验收读本《小步生活》：每天观察光线、整理桌面、照顾绿植、阅读一页、记录感受、散步、伸展、倾听、感谢、准备明天。每个方法可在不同日常场景转化成互不重复的小练习。'));const form=new FormData();form.append('zipFile',new Blob([zip.toBuffer()]),'fictional-book.zip');const response=await fetch(base+'/api/habit/pools/generate',{method:'POST',body:form,signal:AbortSignal.timeout(660000)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));bookPool=value.pool;assert.equal(bookPool.habits.length,30);assert.ok(bookPool.habits.every(item=>typeof item==='string'&&item.trim()));const cleanup=await waitForUploadCleanup(path.join(dataDir,'habit_upload'));return {poolName:bookPool.name,description:bookPool.description,cards:bookPool.habits.length,habits:bookPool.habits,cleanup};});
  await check('wish_purpose','真实愿望第一轮提问、三个选项及增量显示','ai',async()=>{purpose=await wishTurn({stage:'purpose',wish:'我想开始画画'});assert.equal(purpose.result.options.length,3);assert.ok(purpose.growths>1);return {question:purpose.result.question,growths:purpose.growths,options:purpose.result.options};});
  await check('wish_effort','真实愿望第二轮提问、自定义回答上下文','ai',async()=>{effort=await wishTurn({stage:'effort',wish:'我想开始画画',purpose:'想和朋友一起享受画画的乐趣'});assert.equal(effort.result.options.length,3);assert.ok(effort.growths>1);return {question:effort.result.question,growths:effort.growths,options:effort.result.options};});
  await check('wish_pool','真实愿望生成30张唯一短卡并保存上下文','ai',async()=>{wishBody={stage:'generate',wish:'我想开始画画',purpose:'想和朋友一起享受画画的乐趣',effort:'每天五分钟，用手边纸笔轻松尝试，不买设备',requestId:randomUUID()};const result=await wishTurn(wishBody);wishPool=result.result.pool;assert.equal(wishPool.habits.length,30);assert.equal(new Set(wishPool.habits).size,30);assert.equal(wishPool.wishContext.purpose,wishBody.purpose);return {poolName:wishPool.name,cards:wishPool.habits.length,habits:wishPool.habits};});
  await check('wish_retry_draw','真实生成结果重试幂等、抽卡及完成','ai',async()=>{assert.ok(wishPool,'Previous wish generation did not finish');const before=(await request('/api/habit/pools')).pools.length,repeated=await post('/api/habit/wish',wishBody);assert.equal(repeated.pool.id,wishPool.id);assert.equal((await request('/api/habit/pools')).pools.length,before);const drawn=(await post('/api/habit/draw',{poolId:wishPool.id})).log;assert.equal((await put('/api/habit/log/'+drawn.id+'/complete',{})).completed,true);});
  await check('ai_history_delete','真实图谱、摘要和标签建议历史读取及删除','ai',async()=>{const history=await request('/api/cc/suggestions');assert.ok(history.graphHistory.length);for(const entry of history.graphHistory)await remove('/api/cc/graph/'+entry.id);if(history.weeklyDigests.length)await remove('/api/cc/weekly-digest/0');if(history.tagSuggestionHistory.length)await remove('/api/cc/tag-suggestion/0');assert.equal((await request('/api/cc/suggestions')).graphHistory.length,0);});
  await check('ai_restart_saved','真实 AI 结果和卡池重启后可读','ai',async()=>{const before=(await request('/api/habit/pools')).pools.length;assert.ok(before>=2);await stop();await start();assert.equal((await request('/api/habit/pools')).pools.length,before);assert.ok((await request('/api/cc/suggestions')).dailyDigest.summary);assert.equal((await request('/api/ai/status')).busy,false);});
  report.finishedAt=new Date().toISOString();report.summary=report.cases.reduce((all,row)=>(all[row.status]=(all[row.status]||0)+1,all),{});save();console.log(JSON.stringify({report:filename,...report.summary}));
  if(report.cases.some(row=>row.status==='failed'))process.exitCode=1;
}
main().catch(error=>{report.fatal=error.stack;save();console.error(error.stack);process.exitCode=1;}).finally(async()=>{await stop();save();fs.rmSync(root,{recursive:true,force:true});for(const cleanup of cleanups)cleanup();});
