// Real summary regression with fictional records and an isolated SQLite store.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {Store}=require('../storage/store');
const {TaskService}=require('../tasks/service');
const {invokeAgent,resolveCli}=require('../agents');
const {localDate,localTimestamp,periodFor}=require('../tasks/dates');
const agent=process.env.MEMO_TEST_AGENT || 'codebuddy';
assert.ok(['codebuddy','codex'].includes(agent),'This runner is for an explicitly selected real assistant.');
const actions=(process.env.MEMO_SUMMARY_ACTIONS || 'daily-digest,weekly-digest').split(',').filter(Boolean);
assert.ok(actions.length && actions.every(action=>['daily-digest','weekly-digest'].includes(action)),'Unsupported summary action.');
const out=path.resolve(process.env.MEMO_ACCEPTANCE_OUT),root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-summary-live-'));
fs.mkdirSync(out,{recursive:true});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MEMO_FAKE_'))delete env[key];
const report={agent,realCli:true,fictionalData:true,startedAt:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,calls:[],cases:[],manualReviewStatus:'pending'};
const filename=path.join(out,agent+'-summary-live.json');
const save=()=>fs.writeFileSync(filename,JSON.stringify(report,null,2)+'\n');
let store;
async function run(){
 report.cli=resolveCli(agent,{env,configDir:root});assert.ok(report.cli,'Real CLI unavailable');
 store=new Store(path.join(root,'data'),{automaticBackup:false});
 const now=new Date(),yesterday=new Date(now);yesterday.setDate(now.getDate()-1);
 const themes=[{tags:['阅读','读书'],text:'睡前读十分钟书，记下一个值得继续想的问题'},{tags:['运动','锻炼'],text:'散步十五分钟，注意呼吸和路边植物的变化'},{tags:['生活','整理'],text:'归位桌面上的三件物品，为明天留出安静空间'}];
 const memos=Array.from({length:90},(_,i)=>({id:'fictional-summary-'+(i+1),content:themes[i%3].text+'。记录中的小线索编号为'+(i+1)+'。',tags:themes[i%3].tags,createdAt:(i<70?now:yesterday).toISOString()}));
 store.update('memos',data=>{data.memos=memos;});
 report.fixture={totalMemos:90,dateCounts:{[localDate(yesterday)]:20,[localDate(now)]:70},tagCounts:Object.fromEntries(themes.flatMap(theme=>theme.tags.map(tag=>[tag,30]))),notes:memos};save();
 const ask=async prompt=>{
   const task=prompt.match(/^TASK=([^\n]+)/m)[1],input=JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
   const call={task,input,prompt,startedAt:new Date().toISOString(),deltas:0,firstDeltaMs:null};report.calls.push(call);save();
   const start=Date.now();
   try{call.output=await invokeAgent(agent,prompt,{cwd:root,configDir:root,env,timeoutMs:300000,onEvent:event=>{if(event.type==='delta'){call.deltas++;if(call.firstDeltaMs===null)call.firstDeltaMs=Date.now()-start;}}});return call.output;}
   catch(error){call.error=error.message;throw error;}
   finally{call.elapsedMs=Date.now()-start;call.finishedAt=new Date().toISOString();save();}
 };
 for(const action of actions){
   const asOf=new Date(),row={action,startedAt:asOf.toISOString(),asOfLocal:localTimestamp(asOf),expectedPeriod:periodFor(action,asOf),status:'running'};report.cases.push(row);save();
   console.log(JSON.stringify({agent,action,status:'running'}));
   try{const result=await new TaskService(store,{ask}).digest(action,{},asOf);row.digest=result.digest;assert.equal(result.digest.coverage.processedCount,90);assert.equal(result.digest.coverage.batchCount,2);assert.equal(result.digest.asOfLocal,localTimestamp(asOf));assert.deepEqual(result.digest.tagTrends,report.fixture.tagCounts);row.saved=store.read('suggestions')[action==='daily-digest'?'dailyDigest':'weeklyDigest'];assert.deepEqual(row.saved,result.digest);row.status='passed-structure-awaiting-manual-review';}
   catch(error){row.status='failed';row.error=error.stack;process.exitCode=1;}
   row.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({agent,action,status:row.status,summary:row.digest?.summary,error:row.error}));
 }
}
run().catch(error=>{report.fatal=error.stack;process.exitCode=1;}).finally(()=>{report.finishedAt=new Date().toISOString();save();store?.close();fs.rmSync(root,{recursive:true,force:true});console.log(filename);});
