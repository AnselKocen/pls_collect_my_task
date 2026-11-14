// Manual benchmark: fixed fictional records, fresh isolated threads, no app settings changed.
// Run with Node 22+: node test/codex-latency-benchmark.js /tmp/memo-codex-benchmark.json
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {spawn}=require('child_process'),{once}=require('events');
const {performance}=require('perf_hooks');
const {resolveCli}=require('../agents');
const {promptFor}=require('../tasks/prompts');
const model='gpt-6.1-sol';
const pairs=[['reading','books'],['fitness','exercise'],['cooking','recipes'],['music','songs'],['travel','trips'],['coding','programming'],['films','movies'],['gardening','plants']];
const records=pairs.map((tags,index)=>({id:'fictional-'+(index+1),content:'Fictional integration-test record about '+tags.join(' and ')+'. Both labels describe the same activity.',tags,createdAt:'2026-11-01T08:00:00.000Z',recordedDate:'2026-11-01'}));
const counts=Object.fromEntries(pairs.flat().map(tag=>[tag,1]));
const prompt='This is a synthetic latency benchmark. Use only the fictional data below. Do not read files or call tools.\n'+promptFor('tag-suggestions',{records,tagCounts:counts,globalTagCounts:counts,scope:{tags:[]}});
const output=path.resolve(process.argv[2] || path.join(os.tmpdir(),'memo-codex-latency-benchmark.json'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-codex-benchmark-'));
const transport=process.env.MEMO_BENCH_TRANSPORT || 'default';
assert.ok(['default','http'].includes(transport));
const order=(process.env.MEMO_BENCH_EFFORTS || 'low,medium,medium,low').split(',');
assert.ok(order.length && order.every(effort=>['low','medium'].includes(effort)));
const report={model,transport,createdAt:new Date().toISOString(),fictionalRecords:records.length,promptChars:prompt.length,order,runs:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
const log=value=>console.log(JSON.stringify(value));
function classify(error) {
  const text=String(error?.message || error || '');
  if(/websocket/i.test(text))return 'websocket';
  if(/timed?\s*out|timeout/i.test(text))return 'timeout';
  if(/429|rate.?limit/i.test(text))return 'rate-limit';
  if(/connect|stream|network/i.test(text))return 'connection';
  if(/authoriz|authenticat|login/i.test(text))return 'authentication';
  return 'other';
}
const sanitized=text=>String(text || '').replace(/https?:\/\/[^\s)"']+/g,'[endpoint]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(?:sk-|eyJ)[A-Za-z0-9_.-]{15,}/g,'[redacted]').slice(0,700);
function quality(raw) {
  const result={validJSON:false,validSchema:false,pairsCovered:0,crossPairMerges:0,suggestions:0};
  try {
    const items=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
    result.validJSON=true;assert.ok(Array.isArray(items));
    for(const item of items) {
      assert.ok(['merge','review'].includes(item.action));assert.ok(Array.isArray(item.tags));
      assert.ok(item.tags.length>=(item.action==='merge'?2:1));
      assert.ok(item.tags.every(tag=>Object.hasOwn(counts,tag)));assert.ok(typeof item.reason==='string' && item.reason.trim());
      assert.ok((item.memoIds || []).every(id=>records.some(record=>record.id===id)));
    }
    result.validSchema=true;result.suggestions=items.length;
    result.pairsCovered=pairs.filter(pair=>items.some(item=>item.action==='merge' && pair.every(tag=>item.tags.includes(tag)))).length;
    result.crossPairMerges=items.filter(item=>item.action==='merge' && new Set(item.tags.map(tag=>pairs.findIndex(pair=>pair.includes(tag)))).size>1).length;
    result.items=items;
  } catch { /* A malformed response remains a measured failure rather than a repaired run. */ }
  return result;
}
async function run(effort,index) {
  const cwd=path.join(root,String(index));fs.mkdirSync(cwd);
  const command=resolveCli('codex');if(!command)throw new Error('Codex CLI unavailable');
  const started=performance.now(),elapsed=()=>Math.round(performance.now()-started);
  const metrics={index,effort,model,transport,startedAt:new Date().toISOString(),retryEvents:[],stderrSignals:{},deltaCount:0,firstTextMs:null,lastTextMs:null,firstReasoningEventMs:null};
  const overrides=[`model_reasoning_effort="${effort}"`,...(transport==='http'?[
    'model_provider="memo_http"','model_providers.memo_http.name="OpenAI HTTP"',
    'model_providers.memo_http.wire_api="responses"','model_providers.memo_http.requires_openai_auth=true',
    'model_providers.memo_http.supports_websockets=false'
  ]:[])];
  const child=spawn(command,['app-server','--listen','stdio://',...overrides.flatMap(value=>['--config',value])],{cwd,env:process.env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  let sequence=0,threadId,buffer='',stderrBuffer='',lastAnswer='',doneResolve,doneReject;
  const answers=new Map(),pending=new Map();
  const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});done.catch(()=>{});
  const fail=error=>{doneReject(error);for(const call of pending.values())call.reject(error);pending.clear();};
  const send=row=>child.stdin.write(JSON.stringify(row)+'\n');
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({id,method,params});});
  const timer=setTimeout(()=>fail(new Error('Benchmark timeout')),210000);
  child.stdin.on('error',()=>{});child.once('error',fail);
  child.once('exit',()=>fail(new Error('CLI exited before completion')));
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{
    stderrBuffer=(stderrBuffer+chunk).slice(-32768);
    for(const [key,pattern]of Object.entries({websocket:/websocket/i,timeout:/timed?\s*out|timeout/i,connection:/connect.*fail|stream.*disconnec/i})) {
      if(pattern.test(chunk))metrics.stderrSignals[key]=(metrics.stderrSignals[key] || 0)+1;
    }
  });
  child.stdout.on('data',chunk=>{
    buffer+=chunk;let boundary;
    while((boundary=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);let row;
      try{row=JSON.parse(line);}catch{continue;}
      if(row.id!==undefined && !row.method) {
        const call=pending.get(row.id);if(!call)continue;pending.delete(row.id);
        row.error?call.reject(new Error(row.error.message || 'RPC error')):call.resolve(row.result);continue;
      }
      if(row.id!==undefined && row.method) {send({id:row.id,error:{code:-32601,message:'Benchmark does not use tools'}});fail(new Error('Unexpected tool request'));continue;}
      const p=row.params || {};if(threadId && p.threadId && p.threadId!==threadId)continue;
      if(row.method==='error') {
        const entry={ms:elapsed(),willRetry:!!p.willRetry,category:classify(p.error),code:p.error?.codexErrorInfo || null,message:sanitized(p.error?.message)};
        metrics.retryEvents.push(entry);log({event:'retry',index,effort,...entry});
        if(!p.willRetry)fail(new Error('Codex request failed: '+entry.category));
      } else if(row.method==='item/agentMessage/delta') {
        if(metrics.firstTextMs===null){metrics.firstTextMs=elapsed();log({event:'firstText',index,effort,ms:metrics.firstTextMs,retries:metrics.retryEvents.length});}
        metrics.lastTextMs=elapsed();metrics.deltaCount++;
        answers.set(p.itemId,(answers.get(p.itemId) || '')+(p.delta || ''));
      } else if(row.method==='item/completed' && p.item?.type==='agentMessage' && p.item.phase!=='commentary')lastAnswer=p.item.text || '';
      else if(row.method==='item/started' && p.item?.type==='reasoning' && metrics.firstReasoningEventMs===null)metrics.firstReasoningEventMs=elapsed();
      else if(row.method==='thread/tokenUsage/updated') {
        const usage=p.tokenUsage?.total || p.tokenUsage?.last || {};
        metrics.tokens=Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'].filter(key=>typeof usage[key]==='number').map(key=>[key,usage[key]]));
      } else if(row.method==='turn/completed') {
        metrics.turnCompletedMs=elapsed();
        p.turn?.status==='completed'?doneResolve(lastAnswer || [...answers.values()].at(-1) || ''):fail(new Error('Turn did not complete'));
      }
    }
  });
  log({event:'start',index,effort});
  try {
    await request('initialize',{clientInfo:{name:'memo_journal',title:'记忆手帐',version:'1.0.0'},capabilities:{}});
    metrics.initializedMs=elapsed();send({method:'initialized'});
    const thread=await request('thread/start',{model,cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',serviceTier:'default',config:{model_reasoning_effort:effort}});
    threadId=thread.thread.id;metrics.threadReadyMs=elapsed();metrics.actualModel=thread.model;metrics.actualEffort=thread.reasoningEffort;metrics.actualProvider=thread.modelProvider;
    assert.equal(thread.model,model);assert.equal(thread.reasoningEffort,effort);
    if(transport==='http')assert.equal(thread.modelProvider,'memo_http');
    metrics.turnRequestedMs=elapsed();
    await request('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],effort,summary:'none'});
    metrics.turnAcceptedMs=elapsed();log({event:'accepted',index,effort,ms:metrics.turnAcceptedMs,actualModel:metrics.actualModel,actualEffort:metrics.actualEffort});
    const raw=await done;
    metrics.quality=quality(raw);metrics.answerChars=raw.length;
    metrics.status=metrics.quality.validSchema?'completed':'invalid-output';
  } catch(error) {metrics.status='failed';metrics.failure=classify(error);metrics.failureMessage=sanitized(error.message);}
  finally {
    clearTimeout(timer);child.stdin.end();
    const kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}},500);kill.unref();
    const hardKill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);hardKill.unref();
    if(child.exitCode===null && child.signalCode===null)await once(child,'close');
    clearTimeout(kill);clearTimeout(hardKill);metrics.totalMs=elapsed();
    if(metrics.status==='failed')metrics.stderrSummary=sanitized(stderrBuffer);
  }
  const {quality:detail,...brief}=metrics;log({event:'complete',...brief,quality:detail?{...detail,items:undefined}:null});
  return metrics;
}
(async()=>{
  save();
  for(const [index,effort]of report.order.entries()) {report.runs.push(await run(effort,index+1));save();}
  log({event:'finished',report:output});
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{fs.rmSync(root,{recursive:true,force:true});});
