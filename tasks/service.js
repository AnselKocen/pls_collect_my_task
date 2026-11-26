const { randomUUID } = require('crypto');
const { promptFor, VERSION } = require('./prompts');
const { localDate, parseLocalDate, addDays, periodFor, rangeFor } = require('./dates');

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 需要非空文字`);
  return value.trim();
}
function list(value, name) { if (!Array.isArray(value)) throw new Error(`${name} 需要数组`); return value; }
function unique(values) { return [...new Set(values)]; }
function sourceIds(value, allowed) {
  const ids = unique(list(value ?? [],'memoIds'));
  if (ids.some(id => !allowed.has(id))) throw new Error('来源引用范围外便签');
  return ids;
}
function parseJSON(raw) {
  const clean = String(raw).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(clean); } catch { throw new Error('没有返回有效 JSON'); }
}

// Split oversized notes as well as collections. All fragments retain the original id.
function batchRecords(memos, { maxChars = 18000, maxRecords = 60 } = {}) {
  const fragments = [];
  for (const memo of memos) {
    const date = new Date(typeof memo.createdAt === 'string' ? memo.createdAt : NaN);
    const base = { id:memo.id, tags:memo.tags, createdAt:memo.createdAt ?? null, recordedDate:Number.isFinite(date.getTime()) ? localDate(date) : null };
    const overhead = JSON.stringify({...base,content:'',part:999999,parts:999999}).length;
    const allowance = maxChars-overhead-16;
    if (allowance < 100) throw new Error('单条便签的标签或ID过长，无法组织分析输入');
    const parts = []; let current = '', used = 0;
    for (const character of memo.content) {
      const cost = JSON.stringify(character).length-2;
      if (used+cost > allowance && current) { parts.push(current); current=''; used=0; }
      current += character; used += cost;
    }
    parts.push(current);
    parts.forEach((content,index) => fragments.push({...base,content,...(parts.length > 1 ? {part:index+1,parts:parts.length} : {})}));
  }
  const batches = []; let current = [], used = 2;
  for (const fragment of fragments) {
    const size = JSON.stringify(fragment).length+1;
    if (current.length && (used+size > maxChars || current.length >= maxRecords)) { batches.push(current);current=[];used=2; }
    current.push(fragment); used+=size;
  }
  if (current.length || !batches.length) batches.push(current);
  return batches;
}

async function askValidated(ask, task, input, validate) {
  let correction = '';
  for (let attempt=0; attempt<2; attempt++) {
    const result = await ask(promptFor(task,input,correction));
    try { return validate(parseJSON(result)); }
    catch (error) { correction=error.message; }
  }
  throw new Error(`AI 结果校验失败：${correction}，本次结果未保存`);
}

function validateGraph(result, records) {
  const allowed = new Set(records.map(record => record.id));
  const seen = new Set();
  const nodes = list(result.nodes,'nodes').map(node => {
    const id = typeof node.id === 'number' ? String(node.id) : text(node.id,'节点ID');
    if (seen.has(id)) throw new Error('节点ID重复');
    seen.add(id);
    const tag = node.tag == null ? '未分类' : text(node.tag,'节点标签');
    return {id,label:text(node.label,'节点标题'),tag,clusterId:'tag:'+tag,memoIds:sourceIds(node.memoIds,allowed)};
  });
  if(records.length && !nodes.length)throw new Error('图谱结果没有节点');
  const edges = list(result.edges ?? [],'edges').map(edge => {
    const source=String(edge.source),target=String(edge.target);
    if (!seen.has(source) || !seen.has(target)) throw new Error('连线端点无效');
    return {source,target,relation:text(edge.relation,'关系描述'),...(edge.kind ? {kind:edge.kind} : {}),memoIds:sourceIds(edge.memoIds,allowed)};
  });
  const summaries = list(result.summaries ?? [],'summaries').map(item => ({tag:text(item.tag,'总结标签'),summary:text(item.summary,'标签总结')}));
  if (typeof (result.insights ?? '') !== 'string') throw new Error('insights 需要文字');
  // Derive display groups from the original node tags, without changing the
  // model's concepts, discussions or discoveries to fit a new graph schema.
  const clusters = unique(nodes.map(node=>node.tag)).map(tag => {
    const members=nodes.filter(node=>node.tag===tag);
    return {id:'tag:'+tag,title:tag,summary:summaries.filter(item=>item.tag===tag).map(item=>item.summary).join('\n\n'),memoIds:unique(members.flatMap(node=>node.memoIds))};
  });
  return {nodes,edges,summaries,insights:result.insights ?? '',clusters,clusterEdges:[]};
}

function tagCounts(memos, catalog = []) {
  const counts = Object.fromEntries(catalog.map(tag => [tag,0]));
  for (const memo of memos) for (const tag of unique(memo.tags)) Object.defineProperty(counts,tag,{value:(Object.hasOwn(counts,tag) ? counts[tag] : 0)+1,writable:true,enumerable:true,configurable:true});
  return counts;
}
function validateTags(result, counts, allowedRecords) {
  return list(result,'标签建议').map(suggestion => {
    if (!['merge','review'].includes(suggestion.action)) throw new Error('标签建议类型无效');
    const tags = unique(list(suggestion.tags,'建议标签'));
    if (tags.length < (suggestion.action === 'merge' ? 2 : 1) || tags.some(tag => !Object.hasOwn(counts,tag))) throw new Error('建议标签不存在或数量不足');
    const memoIds = sourceIds(suggestion.memoIds,allowedRecords);
    return {action:suggestion.action,tags,reason:text(suggestion.reason,'建议理由'),memoIds};
  });
}
function digestStatistics(records, period) {
  const memos=[...new Map(records.map(record=>[record.id,record])).values()],dateCounts={};
  for(let day=parseLocalDate(period.from);localDate(day)<=period.to;day=addDays(day,1))dateCounts[localDate(day)]=0;
  for(const memo of memos) {
    const time=new Date(memo.createdAt);
    if(Number.isFinite(time.getTime())) {
      const date=localDate(time);
      dateCounts[date]=(dateCounts[date] || 0)+1;
    }
  }
  return {totalMemos:memos.length,dateCounts,tagCounts:tagCounts(memos)};
}

function validateDigestFacts(result, {period,programFacts}={}) {
  if(!period)return;
  for(const field of ['date','week'])if(Object.hasOwn(result,field) && result[field]!==period[field])throw new Error(`${field}与程序日期事实不一致，请使用${JSON.stringify(period[field])}或省略该字段`);
  if(Object.hasOwn(result,'tagTrends')) {
    const value=result.tagTrends,expected=programFacts.tagCounts;
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==Object.keys(expected).length || Object.keys(expected).some(tag=>!Object.hasOwn(value,tag) || value[tag]!==expected[tag]))throw new Error('tagTrends与程序全范围标签计数不一致，请使用programFacts.tagCounts或省略该字段');
  }
  // Check only explicit current-data cutoffs with an explicit zone. Other dates,
  // quoted history and ordinary numeric/content analysis are not interpreted.
  const claims=String(result.summary || '').matchAll(/(?:^|[\n。；])\s*(?:(?:本周|本次|本日)(?:范围|统计范围)(?:为|[:：])?[^。\n；]{0,100}[，,]\s*)?(?:本次数据截至|本次数据截止|数据截至|数据截止)\s*(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2}:\d{2})(?::\d{2})?\s*[（(]\s*([^\s）)]+)\s*[）)]/g);
  for(const claim of claims) {
    if(claim[1]!==period.date)continue;
    const zone=claim[3],clock=claim[2].padStart(5,'0');
    const expected=zone===period.timezone ? period.asOfLocal : /^(?:UTC|GMT|Z)$/i.test(zone) ? period.asOf : null;
    if(expected && clock!==expected.slice(11,16))throw new Error(`本次截止时间与程序时区事实不一致：${period.timezone}请使用${period.asOfLocal}；UTC请使用${period.asOf}`);
  }
}

function validateDigest(result, context) {
  const tasks = list(result.tasks ?? [],'tasks');
  if(tasks.some(task=>typeof task!=='string' || !task.trim()))throw new Error('tasks 必须是非空字符串数组，例如 ["阅读一页"]；没有待办时返回 []，不要使用对象、null 或空字符串');
  validateDigestFacts(result,context);
  return {summary:text(result.summary,'摘要'),tasks:tasks.map(task => text(task,'待办'))};
}

class TaskService {
  constructor(store, { ask, batchOptions, onProgress = () => {} } = {}) {
    this.store=store;this.ask=ask;this.batchOptions=batchOptions;this.onProgress=onProgress;
  }
  select(params = {}, period) {
    const tags=params.tags ?? [];
    const range=period || rangeFor(params);
    return this.store.queryMemos({tags,ids:params.ids,...range});
  }
  coverage(memos, batches, params = {}, period) {
    return {matchedCount:memos.length,processedCount:memos.length,batchCount:batches.length,complete:true,tags:params.tags ?? [],...(period || {from:params.from || null,to:params.to || null}),promptVersion:VERSION};
  }
  async graph(params = {}) {
    const memos=this.select(params);
    if (!memos.length) throw new Error('选定范围没有便签，请调整标签或日期');
    const tags=params.tags?.length ? params.tags : unique(memos.flatMap(memo=>memo.tags));
    const batches=batchRecords(memos,this.batchOptions), parts=[];
    for (const [index,records] of batches.entries()) {
      this.onProgress(`图谱分析 ${index+1}/${batches.length}`);
      parts.push(await askValidated(this.ask,'graph',{scope:{tags,from:params.from || null,to:params.to || null,totalMemos:memos.length,batch:index+1,batches:batches.length},records},result => validateGraph(result,records)));
    }
    let graph;
    if (parts.length === 1) graph=parts[0];
    else {
      const input={graphs:parts.map(({nodes,edges,summaries,insights})=>({nodes,edges,summaries,insights})),scope:{tags,totalMemos:memos.length}};
      if (JSON.stringify(input).length > 60000) throw new Error('主题归并范围过大，请缩小标签或日期范围后重试；本次未保存部分图谱');
      this.onProgress('综合全部图谱分析');
      graph=await askValidated(this.ask,'graph-merge',input,result => validateGraph(result,memos));
    }
    graph.edges=[...new Map(graph.edges.map(edge => [[edge.source,edge.target].sort().join('\0')+'\0'+edge.relation,edge])).values()];
    const entry={...graph,id:randomUUID(),tags,coverage:this.coverage(memos,batches,params),generatedAt:new Date().toISOString(),version:3};
    this.store.update('suggestions',data => {if(!data.graphHistory)data.graphHistory=[];data.graphHistory.push(entry);});
    return {type:'graph',graph:entry};
  }
  async tags(params = {}) {
    const memos=this.select(params),batches=batchRecords(memos,this.batchOptions);
    const globalCounts=this.store.countTags(),counts=tagCounts(memos,Object.keys(globalCounts)),parts=[];
    for(const [index,records] of batches.entries()) {
      this.onProgress(`标签整理 ${index+1}/${batches.length}`);
      parts.push(...await askValidated(this.ask,'tag-suggestions',{tagCounts:counts,globalTagCounts:globalCounts,records,scope:{tags:params.tags ?? [],from:params.from || null,to:params.to || null,totalMemos:memos.length,batch:index+1,batches:batches.length}},result => validateTags(result,globalCounts,new Map(records.map(record=>[record.id,record])))));
    }
    let suggestions=parts;
    if(batches.length>1 && parts.length) {
      const ids=new Set(parts.flatMap(part=>part.memoIds));
      const allowed=new Map(memos.filter(memo=>ids.has(memo.id)).map(memo=>[memo.id,memo]));
      const input={tagCounts:counts,globalTagCounts:globalCounts,suggestions:parts};
      if(JSON.stringify(input).length>60000)throw new Error('标签建议归并范围过大，请缩小范围后重试；本次结果未保存');
      suggestions=await askValidated(this.ask,'tags-merge',input,result=>validateTags(result,globalCounts,allowed));
    }
    const coverage=this.coverage(memos,batches,params);
    this.store.update('suggestions',data=>{data.tagSuggestions=suggestions;if(!data.tagSuggestionHistory)data.tagSuggestionHistory=[];data.tagSuggestionHistory.unshift({suggestions,coverage,generatedAt:new Date().toISOString()});});
    return {type:'tag-suggestions',suggestions,coverage};
  }
  async digest(action, params = {}, now = new Date()) {
    const period=periodFor(action,now),memos=this.select(params,period),batches=batchRecords(memos,this.batchOptions);
    const counts=tagCounts(memos),parts=[];
    const programFacts={...digestStatistics(memos,period),batchCount:batches.length};
    const batchDetails=batches.map((records,index)=>{
      const stats=digestStatistics(records,period),dates=Object.keys(stats.dateCounts).filter(date=>stats.dateCounts[date]);
      return {number:index+1,total:batches.length,memoCount:stats.totalMemos,fragmentCount:records.length,dateCounts:stats.dateCounts,tagCounts:stats.tagCounts,memoIds:unique(records.map(record=>record.id)),recordedFrom:dates[0] || null,recordedTo:dates.at(-1) || null,partialMemoIds:unique(records.filter(record=>record.parts>1).map(record=>record.id))};
    });
    const validate=result=>validateDigest(result,{period,programFacts});
    if(memos.length) for(const [index,records] of batches.entries()) {
      this.onProgress(`${action==='daily-digest' ? '今日摘要' : '本周总结'} ${index+1}/${batches.length}`);
      parts.push(await askValidated(this.ask,action,{period,scope:{tags:params.tags ?? []},programFacts,batch:batchDetails[index],tagCounts:counts,records},validate));
    }
    let result=parts[0] || {summary:action==='daily-digest' ? `· ${period.from}，暂无记录\n· ${period.date}，暂无记录` : '本周暂无记录。',tasks:[]};
    if(parts.length>1) {
      const input={action,period,scope:{tags:params.tags ?? []},programFacts,tagCounts:counts,summaries:parts.map((part,index)=>({...part,batch:batchDetails[index]}))};
      if(JSON.stringify(input).length>60000)throw new Error('摘要归并范围过大，请缩小范围后重试；本次结果未保存');
      result=await askValidated(this.ask,'digest-merge',input,validate);
    }
    const digest={...result,...period,empty:memos.length===0,tagTrends:counts,tags:params.tags ?? [],coverage:this.coverage(memos,batches,params,period),generatedAt:now.toISOString()};
    this.store.update('suggestions',data=>{
      if(action==='daily-digest')data.dailyDigest=digest;
      else {if(!data.weeklyDigests)data.weeklyDigests=[];data.weeklyDigests.unshift(digest);data.weeklyDigest=digest;}
    });
    return {type:action,digest};
  }
  run(action,params = {},now) {
    if(action==='graph')return this.graph(params);
    if(action==='tag-suggestions')return this.tags(params);
    if(['daily-digest','weekly-digest'].includes(action))return this.digest(action,params,now);
    throw new Error('未知 AI 任务');
  }
}

module.exports={TaskService,batchRecords,parseJSON,validateGraph,validateTags,validateDigest};
