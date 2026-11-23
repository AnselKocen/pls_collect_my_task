const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../storage/store');
const {TaskService,batchRecords}=require('../tasks/service');
const {periodFor,rangeFor,localDate,isoWeek}=require('../tasks/dates');
const {searchScore}=require('../storage/search');
const {makeView}=require('../public/graph-layout');
const {respond}=require('./fake-model');

function setup(t,memos) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-task-test-'));
  const store=new Store(dir,{automaticBackup:false});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.update('memos',data=>{data.memos=memos;});
  return store;
}
function service(store,options={}) {
  const calls=[];
  const ask=async prompt=>{
    const task=prompt.match(/^TASK=([^\n]+)/m)[1];
    const input=JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
    calls.push({task,input});return JSON.stringify(respond(task,input));
  };
  return {engine:new TaskService(store,{ask,...options}),calls};
}
const memo=(id,content,tags=['A'],createdAt='2026-11-13T00:00:00Z')=>({id,content,tags,createdAt,updatedAt:createdAt});

test('literal exact matching and local unordered fuzzy matching handle Chinese, Unicode and wildcards',t=>{
  const store=setup(t,[memo('a','傍晚去公园散步'),memo('b','工作已完成100%',['工作']),memo('c','完成1000项'),memo('d','ＡＢＣ 项目')]);
  assert.equal(searchScore('公园里散步','散步 公园','exact'),0);
  assert.ok(searchScore('公园里散步','散步 公园','fuzzy'));
  assert.deepEqual(store.queryMemos({keyword:'100%'}).map(m=>m.id),['b']);
  assert.deepEqual(store.queryMemos({keyword:'abc'}).map(m=>m.id),['d']);
  assert.deepEqual(store.queryMemos({keyword:'散步 公园',mode:'fuzzy'}).map(m=>m.id),['a']);
  assert.deepEqual(store.queryMemos({keyword:'工作'}).map(m=>m.id),['b']);
  assert.deepEqual(store.queryMemos({tags:['不存在'],keyword:'公园'}),[]);
  assert.throws(()=>store.queryMemos({mode:'ai'}),/搜索模式/);
});

test('local days, natural weeks and ISO week-years include exact boundaries',t=>{
  const previous=process.env.TZ;process.env.TZ='Asia/Shanghai';
  t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  const now=new Date('2026-11-13T04:00:00Z');
  const day=periodFor('daily-digest',now),week=periodFor('weekly-digest',now);
  assert.equal(day.start,'2026-11-11T16:00:00.000Z');assert.equal(day.end,'2026-11-13T16:00:00.000Z');
  assert.equal(day.from,'2026-11-12');assert.equal(day.to,'2026-11-13');
  assert.equal(day.date,'2026-11-13');
  assert.equal(week.from,'2026-11-09');assert.equal(week.to,'2026-11-15');
  assert.equal(isoWeek(new Date('2021-01-01T12:00:00+08:00')),'2020-W53');
  assert.throws(()=>rangeFor({from:'2026-02-30'}),/不存在/);
  assert.throws(()=>rangeFor({from:'2026-11-14',to:'2026-11-13'}),/晚于/);
  const store=setup(t,[memo('before','前天',[],'2026-11-11T15:59:59.999Z'),memo('yesterday','昨天开始',[],'2026-11-11T16:00:00Z'),memo('start','今天开始',[],'2026-11-12T16:00:00Z'),memo('now','当前',[],now.toISOString()),memo('future','尚未发生',[],'2026-11-13T05:00:00Z'),memo('end','明天',[],'2026-11-13T16:00:00Z')]);
  assert.deepEqual(store.queryMemos(day).map(m=>m.id),['yesterday','start','now']);
  assert.deepEqual(store.queryMemos({start:day.start,end:day.end}).map(m=>m.id),['yesterday','start','now','future']);
  assert.equal(localDate(new Date(day.start)),'2026-11-12');
});

test('local calendar arithmetic handles daylight saving days',t=>{
  const previous=process.env.TZ;process.env.TZ='America/New_York';
  t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  const spring=periodFor('daily-digest',new Date('2026-03-08T16:00:00Z'));
  const autumn=periodFor('daily-digest',new Date('2026-11-01T17:00:00Z'));
  assert.equal((Date.parse(spring.end)-Date.parse(spring.start))/3600000,47);
  assert.equal((Date.parse(autumn.end)-Date.parse(autumn.start))/3600000,49);
});

test('batching includes every character of long notes, preserves emoji and covers all records',()=>{
  const content='复杂记录 🌿\n"quoted" '.repeat(300);
  const input=[memo('long',content),...Array.from({length:125},(_,i)=>memo('n'+i,'第'+i+'条'))];
  const batches=batchRecords(input,{maxChars:1000,maxRecords:10});
  assert.equal(batches.flat().filter(row=>row.id==='long').map(row=>row.content).join(''),content);
  assert.equal(new Set(batches.flat().map(row=>row.id)).size,126);
  assert.ok(batches.every(batch=>JSON.stringify(batch).length<=1000));
});

test('graph analyzes more than 100 notes, validates sources, merges clusters and collapses without loss',async t=>{
  const memos=Array.from({length:125},(_,i)=>memo('n'+i,'想法'+i,[i%2?'A':'B']));
  const store=setup(t,memos),{engine,calls}=service(store);
  const {graph}=await engine.graph();
  assert.equal(graph.coverage.processedCount,125);assert.equal(graph.coverage.matchedCount,125);
  assert.equal(graph.nodes.length,125);assert.equal(graph.clusters.length,2);
  assert.equal(new Set(calls.filter(call=>call.task==='graph').flatMap(call=>call.input.records.map(record=>record.id))).size,125);
  assert.equal(calls.at(-1).task,'graph-merge');
  assert.ok(calls.at(-1).input.graphs.every(part=>part.summaries.length && typeof part.insights==='string'));
  const snapshot=JSON.stringify(graph),collapsed=makeView(graph,true),expanded=makeView(graph,false);
  assert.equal(collapsed.nodes.length,2);assert.equal(expanded.nodes.length,125);
  assert.equal(new Set(collapsed.nodes.flatMap(node=>node.memoIds)).size,125);
  assert.equal(JSON.stringify(graph),snapshot);
});

test('graph scope combines exact tags and local date range; failed output is never saved',async t=>{
  const store=setup(t,[memo('a','相关',['A'],'2026-11-13T01:00:00Z'),memo('b','不选',['B'],'2026-11-13T01:00:00Z')]);
  const {engine}=service(store);
  const result=await engine.graph({tags:['A']});assert.deepEqual(result.graph.nodes.map(node=>node.id),['a']);
  const before=store.read('suggestions');let attempts=0;
  const broken=new TaskService(store,{ask:async()=>{attempts++;return '{broken';}});
  await assert.rejects(broken.graph(),/未保存/);assert.equal(attempts,2);
  assert.deepEqual(store.read('suggestions'),before);
  const invented=new TaskService(store,{ask:async()=>JSON.stringify({nodes:[{id:'concept',tag:'A',label:'虚构',memoIds:['not-in-scope']}],edges:[],summaries:[],insights:''})});
  await assert.rejects(invented.graph(),/未保存/);assert.deepEqual(store.read('suggestions'),before);
});

test('tag organization covers all notes beyond 20 per tag and keeps evidence',async t=>{
  const memos=Array.from({length:125},(_,i)=>memo('n'+i,'内容'+i,['A','A']));
  const store=setup(t,memos),{engine,calls}=service(store);
  const result=await engine.tags();
  assert.equal(result.coverage.processedCount,125);
  const maps=calls.filter(call=>call.task==='tag-suggestions');
  assert.equal(maps[0].input.tagCounts.A,125);
  assert.equal(new Set(maps.flatMap(call=>call.input.records.map(record=>record.id))).size,125);
  assert.ok(result.suggestions[0].memoIds.length);
});

test('daily and weekly summaries use server-owned dates and statistics, skip future notes and share history format',async t=>{
  const previous=process.env.TZ;process.env.TZ='Asia/Shanghai';
  t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  const store=setup(t,[memo('previous','上一周',['旧'],'2026-11-08T03:00:00Z'),memo('monday','本周一',['A'],'2026-11-09T01:00:00Z'),memo('yesterday','昨天',['A'],'2026-11-11T16:30:00Z'),memo('today','今天',['A'],'2026-11-12T16:30:00Z'),memo('future','未来',['A'],'2026-11-14T01:00:00Z')]);
  const {engine,calls}=service(store),now=new Date('2026-11-13T04:00:00Z');
  const daily=(await engine.digest('daily-digest',{},now)).digest;
  assert.equal(daily.date,'2026-11-13');assert.deepEqual(daily.tagTrends,{A:2});
  assert.deepEqual(calls[0].input.records.map(record=>record.id),['yesterday','today']);
  const weekly=(await engine.digest('weekly-digest',{},now)).digest;
  assert.equal(weekly.from,'2026-11-09');assert.equal(weekly.to,'2026-11-15');assert.deepEqual(weekly.tagTrends,{A:3});
  assert.deepEqual(calls[1].input.records.map(record=>record.id),['monday','yesterday','today']);
  assert.equal(store.read('suggestions').weeklyDigests[0].week,weekly.week);
  assert.equal(store.read('suggestions').dailyDigest.date,daily.date);
});

test('legacy graph layout remains readable and does not claim unknown source IDs',()=>{
  const old={nodes:[{id:'1',label:'旧节点',tag:'工作'}],edges:[]};
  assert.equal(makeView(old,false).nodes.length,1);
  assert.deepEqual(makeView(old,true).nodes[0].memoIds,[]);
});

test('multiple fragments of one long note retain all their theme groups',async t=>{
  const store=setup(t,[memo('long','长内容'.repeat(500))]);
  const ask=async prompt=>{
    const task=prompt.match(/^TASK=([^\n]+)/m)[1];
    const input=JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
    const result=respond(task,input);
    if(task==='graph') {
      const tag=input.records[0].part===1 ? '前段主题' : '后段主题';
      result.nodes[0].id='concept-'+input.records[0].part;
      result.nodes[0].tag=tag;
      result.summaries=[{tag,summary:'这段文字里的一个想法。'}];
    }
    return JSON.stringify(result);
  };
  const {graph}=await new TaskService(store,{ask,batchOptions:{maxChars:800}}).graph();
  assert.ok(graph.nodes.length>1);assert.equal(graph.clusters.length,2);
  assert.ok(graph.clusters.every(cluster=>cluster.memoIds.includes('long')));
  assert.ok(makeView(graph,true).nodes.every(node=>node.memoIds.includes('long')));
});

test('tag input distinguishes a tag missing from the date range from a globally empty tag',async t=>{
  const store=setup(t,[memo('a','范围内',['A'],'2026-11-13T01:00:00Z'),memo('b','范围外',['B'],'2026-11-01T01:00:00Z')]);
  const {engine,calls}=service(store);
  await engine.tags({from:'2026-11-12',to:'2026-11-14'});
  assert.equal(calls[0].input.tagCounts.B,0);
  assert.equal(calls[0].input.globalTagCounts.B,1);
  assert.deepEqual(calls[0].input.records.map(record=>record.id),['a']);
});

test('original graph concepts, long discussions and Markdown discoveries survive without node-count rules',async t=>{
  const store=setup(t,[memo('a','做产品',['创作']),memo('b','怕总是改不完',['创作']),memo('c','想先让朋友试试',['创作'])]);
  const summary='想早一点做出来，也想再打磨一下。'.repeat(20);
  const discoveries='### 一个值得继续想的方向\n\n'+('这几条放在一起看，可以发现另一条线索。'.repeat(20));
  const ask=async()=>JSON.stringify({nodes:[{id:'idea',label:'想先做出来，也总想再改一点',tag:'创作',memoIds:['a','b','c']}],edges:[],summaries:[{tag:'创作',summary}],insights:discoveries});
  const {graph}=await new TaskService(store,{ask}).graph();
  assert.equal(graph.nodes.length,1);assert.equal(graph.coverage.processedCount,3);
  assert.deepEqual(graph.nodes[0].memoIds,['a','b','c']);
  assert.equal(graph.summaries[0].summary,summary);assert.equal(graph.insights,discoveries);
  assert.equal(graph.clusters[0].summary,summary);
  assert.deepEqual(makeView(graph,true).nodes[0].memoIds,['a','b','c']);
});

test('original graph and tag output shapes work without newly required evidence fields',async t=>{
  const store=setup(t,[memo('a','随手一记')]);
  const original={nodes:[{id:'1',label:'一个想法',tag:'A'},{id:'2',label:'另一个角度',tag:'A'}],edges:[{source:'1',target:'2',relation:'可以一起想想'}],summaries:[{tag:'A',summary:'保留原本的讨论。'}],insights:'继续发散。'};
  const engine=new TaskService(store,{ask:async()=>JSON.stringify(original)});
  const {graph}=await engine.graph();
  assert.equal(graph.nodes.length,2);assert.deepEqual(graph.nodes[0].memoIds,[]);
  assert.equal(graph.edges[0].source,'1');assert.equal(graph.insights,original.insights);
  const reason='对标签边界的具体讨论。'.repeat(20);
  const tags=await new TaskService(store,{ask:async()=>JSON.stringify([{action:'review',tags:['A'],reason}])}).tags();
  assert.equal(tags.suggestions[0].reason,reason);
});

test('long summaries and original task lists are preserved across digest batching',async t=>{
  const store=setup(t,[memo('a','第一条'),memo('b','第二条')]);
  const summary='这一天里值得记下的事。'.repeat(200),tasks=Array.from({length:10},(_,i)=>'待办'+i),calls=[];
  const ask=async prompt=>{
    const task=prompt.match(/^TASK=([^\n]+)/m)[1];
    const input=JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
    calls.push({task,input});return JSON.stringify({summary,tasks});
  };
  const {digest}=await new TaskService(store,{ask,batchOptions:{maxRecords:1}}).digest('daily-digest',{},new Date('2026-11-13T12:00:00Z'));
  assert.equal(digest.summary,summary);assert.deepEqual(digest.tasks,tasks);
  assert.equal(calls.at(-1).task,'digest-merge');assert.equal(calls.at(-1).input.action,'daily-digest');
  assert.equal(calls.at(-1).input.summaries.length,2);
});

test('digest retries explain the string task format and never save malformed task objects',async t=>{
  const store=setup(t,[memo('a','读一页书')]),now=new Date('2026-11-13T12:00:00Z');
  const prompts=[];
  const ask=async prompt=>{
    prompts.push(prompt);
    return JSON.stringify({summary:'这两天都留出一点时间阅读。',tasks:prompts.length===1?[{text:'阅读一页'}]:['阅读一页']});
  };
  const engine=new TaskService(store,{ask});
  const {digest}=await engine.digest('daily-digest',{},now);
  assert.deepEqual(digest.tasks,['阅读一页']);
  assert.equal(prompts.length,2);
  assert.match(prompts[0],/tasks 必须是非空字符串组成的数组/);
  assert.match(prompts[1],/上次结果未通过格式校验.*tasks 必须是非空字符串数组/);
  const before=store.read('suggestions').dailyDigest;
  engine.ask=async()=>JSON.stringify({summary:'无效结果',tasks:[{text:'不应保存'}]});
  await assert.rejects(engine.digest('daily-digest',{},now),/tasks 必须是非空字符串数组/);
  assert.deepEqual(store.read('suggestions').dailyDigest,before);
});

test('empty graph scope makes no model calls and leaves history untouched',async t=>{
  const store=setup(t,[]),{engine,calls}=service(store),before=store.read('suggestions');
  await assert.rejects(engine.graph(),/选定范围没有便签/);
  assert.equal(calls.length,0);assert.deepEqual(store.read('suggestions'),before);
});

test('empty daily and weekly ranges save deterministic empty results without model calls',async t=>{
  const store=setup(t,[]),{engine,calls}=service(store),now=new Date('2026-11-13T04:00:00Z');
  const daily=(await engine.digest('daily-digest',{},now)).digest;
  const weekly=(await engine.digest('weekly-digest',{tags:['不存在']},now)).digest;
  assert.equal(calls.length,0);assert.equal(daily.empty,true);assert.equal(weekly.empty,true);
  assert.deepEqual(daily.tasks,[]);assert.deepEqual(weekly.tagTrends,{});
  assert.equal(store.read('suggestions').dailyDigest.summary,daily.summary);
  assert.equal(store.read('suggestions').weeklyDigests.length,1);
});

test('a model returning an empty graph cannot save over a useful graph',async t=>{
  const store=setup(t,[memo('a','有内容')]),{engine}=service(store);
  await engine.graph();const before=store.read('suggestions');let calls=0;
  const broken=new TaskService(store,{ask:async()=>{calls++;return JSON.stringify({nodes:[],edges:[],summaries:[],insights:''});}});
  await assert.rejects(broken.graph(),/图谱结果没有节点/);
  assert.equal(calls,2);assert.deepEqual(store.read('suggestions'),before);
});

test('empty text, dangling edges and a failed later batch do not save partial results',async t=>{
  const store=setup(t,[memo('a','第一条'),memo('b','第二条')]),{engine}=service(store);
  await engine.graph();const before=store.read('suggestions');
  for(const result of ['',JSON.stringify({nodes:[{id:'one',label:'想法',tag:'A'}],edges:[{source:'one',target:'missing',relation:'错误引用'}]})]) {
    await assert.rejects(new TaskService(store,{ask:async()=>result}).graph(),/未保存/);
    assert.deepEqual(store.read('suggestions'),before);
  }
  let calls=0;
  const ask=async prompt=>{
    if(++calls>1)throw new Error('simulated CLI failure');
    const input=JSON.parse(prompt.split('\nINPUT_JSON\n')[1].split('\nEND_INPUT_JSON')[0]);
    return JSON.stringify(respond('graph',input));
  };
  await assert.rejects(new TaskService(store,{ask,batchOptions:{maxRecords:1}}).graph(),/CLI failure/);
  assert.deepEqual(store.read('suggestions'),before);
});
