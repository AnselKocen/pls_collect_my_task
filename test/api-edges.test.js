const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const AdmZip=require('adm-zip');
const defaults=require('../storage/defaults');

test('empty states, invalid inputs, model failures and local habit dates', {timeout:30000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-edge-test-'));
  let child;
  t.after(async()=>{
    if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const fixture=defaults();
  fixture['memos.json'].memos=[];fixture['habit_pools.json'].pools=[];
  fixture['settings.json'].tags=['创作','日常','空标签'];
  for(const [name,value] of Object.entries(fixture))fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
  const fake=path.join(dir,process.platform==='win32' ? 'fake-claude.cmd' : 'fake-claude');
  const cli=path.join(__dirname,'fake-model-cli.js'),quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  fs.writeFileSync(fake,process.platform==='win32' ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o755});
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,capture=path.join(dir,'calls.jsonl'),mode=path.join(dir,'mode');
  // Choose a timezone whose current calendar date differs from UTC.
  const timezone=new Date().getUTCHours()<12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,MEMO_ELECTRON:'1',MEMO_DATA_DIR:dir,PORT:String(port),TZ:timezone,CLAUDE_CLI:fake,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_INVALID_FILE:mode},stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',data=>{output+=data;});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(output)),10000);
    child.stdout.on('data',data=>{output+=data;if(output.includes('Memo server running')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup failed '+code+': '+output));});
  });
  const calls=()=>fs.existsSync(capture) ? fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
  async function request(route,{method='GET',body,status=200,storage=false}={}) {
    const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(storage)headers['X-Memo-Storage']='1';
    const response=await fetch(base+route,{method,headers,body:body===undefined ? undefined : JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  const ask=(action,params={},status=200)=>request('/api/cc/ask',{method:'POST',body:{action,params},status});
  async function upload(zip,status=200) {
    const body=new FormData();body.append('zipFile',new Blob([zip]),'book.zip');
    const response=await fetch(base+'/api/habit/pools/generate',{method:'POST',body});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  let emptyBackup,memo,pool;

  await t.test('empty lists, search, blind box, calendar and pending reminders return empty data',async()=>{
    assert.deepEqual(await request('/api/memos'),[]);
    assert.deepEqual(await request('/api/memos?keyword=no-match'),[]);
    assert.equal(await request('/api/memos/random'),null);
    assert.deepEqual((await request('/api/habit/pools')).pools,[]);
    assert.deepEqual((await request('/api/habit/today')).logs,[]);
    assert.deepEqual((await request('/api/habit/calendar?year=2026&month=11')).calendar,{});
    assert.deepEqual((await request('/api/scheduled')).tasks,[]);
    assert.deepEqual((await request('/api/scheduled/pending')).pending,[]);
    assert.equal(calls().length,0);
  });
  await t.test('an empty graph scope never invokes a model or creates history',async()=>{
    const result=await ask('graph',{},400);assert.match(result.error,/选定范围没有便签/);
    assert.equal(calls().length,0);assert.deepEqual((await request('/api/cc/suggestions')).graphHistory,[]);
  });
  await t.test('empty daily and weekly summaries are generated locally',async()=>{
    assert.equal((await ask('daily-digest')).digest.empty,true);
    const weekly=(await ask('weekly-digest')).digest;
    assert.equal(weekly.empty,true);assert.deepEqual(weekly.tasks,[]);assert.deepEqual(weekly.tagTrends,{});
    assert.equal(calls().length,0);
  });
  await t.test('empty tag analysis accepts no suggestions and records zero processed notes',async()=>{
    const result=await ask('tag-suggestions');
    assert.deepEqual(result.suggestions,[]);assert.equal(result.coverage.processedCount,0);
    assert.equal(calls().at(-1).task,'tag-suggestions');
    assert.deepEqual(calls().at(-1).input.records,[]);
    emptyBackup=await request('/api/storage/backup',{method:'POST',storage:true});
  });
  await t.test('blank and non-text note content cannot be stored or replace an existing note',async()=>{
    for(const content of ['', ' \n\t ',42,null])await request('/api/memos',{method:'POST',body:{content},status:400});
    memo=await request('/api/memos',{method:'POST',body:{content:'散步时想到了一个小点子 🌿\n先记下来',tags:['创作','日常']}});
    await request('/api/memos/'+memo.id,{method:'PUT',body:{content:'  '},status:400});
    assert.equal((await request('/api/memos'))[0].content,memo.content);
    await request('/api/memos/missing',{method:'PUT',body:{content:'有效文字'},status:404});
  });
  await t.test('pinning, literal wildcard search, fuzzy search and clearing filters preserve records',async()=>{
    await request('/api/memos/'+memo.id,{method:'PUT',body:{pinned:true}});
    assert.equal((await request('/api/memos'))[0].pinned,true);
    assert.equal((await request('/api/memos?keyword='+encodeURIComponent('点子 散步')+'&mode=fuzzy'))[0].id,memo.id);
    assert.deepEqual(await request('/api/memos?keyword=%25'),[]);
    assert.deepEqual(await request('/api/memos?keyword=no-match'),[]);
    assert.equal((await request('/api/memos')).length,1);
  });
  await t.test('tag validation, renaming and multi-tag filtering behave consistently',async()=>{
    await request('/api/tags',{method:'POST',body:{tag:'  '},status:400});
    await request('/api/tags/'+encodeURIComponent('创作'),{method:'PUT',body:{newTag:'日常'},status:409});
    await request('/api/tags/'+encodeURIComponent('创作'),{method:'PUT',body:{newTag:'小点子'}});
    assert.deepEqual((await request('/api/memos'))[0].tags,['小点子','日常']);
    assert.equal((await request('/api/memos?tags='+encodeURIComponent(JSON.stringify(['小点子'])))).length,1);
  });
  await t.test('bad graph date ranges are rejected without model calls',async()=>{
    const before=calls().length;
    await ask('graph',{from:'2026-02-30'},400);
    await ask('graph',{from:'2026-11-14',to:'2026-11-13'},400);
    assert.equal(calls().length,before);
  });
  await t.test('malformed, blank, empty and failed model outputs keep the last useful graph',async()=>{
    await ask('graph');const before=(await request('/api/cc/suggestions')).graphHistory;
    for(const value of ['graph','blank:graph','empty:graph','fail:graph']) {
      fs.writeFileSync(mode,value);await ask('graph',{},400);
      assert.deepEqual((await request('/api/cc/suggestions')).graphHistory,before);
      assert.equal((await request('/api/cc/status')).busy,false);
    }
    fs.unlinkSync(mode);
  });
  await t.test('an unavailable CLI gives an error and releases the task lock',async()=>{
    fs.renameSync(fake,fake+'.disabled');
    try { const result=await ask('graph',{},400);assert.match(result.error,/AGENT_CLI_MISSING:cc/); }
    finally { fs.renameSync(fake+'.disabled',fake); }
    assert.equal((await request('/api/cc/status')).busy,false);
  });
  await t.test('missing pools, empty uploads and books without text give useful errors',async()=>{
    await request('/api/habit/draw',{method:'POST',body:{},status:400});
    await request('/api/habit/draw',{method:'POST',body:{poolId:'missing'},status:404});
    await request('/api/habit/pools/generate',{method:'POST',status:400});
    await upload(Buffer.from('not a ZIP'),500);
    const before=calls().length;await upload(new AdmZip().toBuffer(),500);
    assert.equal(calls().length,before);assert.deepEqual((await request('/api/habit/pools')).pools,[]);
  });
  await t.test('book generation rejects empty model habits and cleans upload files',async()=>{
    const zip=new AdmZip();zip.addFile('book.txt',Buffer.from('每天从一个小动作开始。'));
    fs.writeFileSync(mode,'empty:habit-pool');await upload(zip.toBuffer(),500);fs.unlinkSync(mode);
    assert.deepEqual((await request('/api/habit/pools')).pools,[]);
    pool=(await upload(zip.toBuffer())).pool;assert.equal(pool.habits.length,30);
    assert.deepEqual(fs.readdirSync(path.join(dir,'habit_upload')),[]);
  });
  await t.test('habit draw, today and calendar use the same local date across a UTC boundary',async()=>{
    const {log}=await request('/api/habit/draw',{method:'POST',body:{poolId:pool.id}});
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(log.drawnAt)).map(part=>[part.type,part.value]));
    const expected=`${parts.year}-${parts.month}-${parts.day}`;
    assert.equal(log.date,expected);assert.notEqual(log.date,log.drawnAt.slice(0,10));
    assert.equal((await request('/api/habit/today')).logs[0].id,log.id);
    await request('/api/habit/log/'+log.id+'/complete',{method:'PUT'});
    assert.equal((await request(`/api/habit/calendar?year=${parts.year}&month=${parts.month}`)).calendar[expected],'completed');
    await request('/api/habit/pools/'+pool.id,{method:'PUT',body:{habits:[]}});
    const empty=await request('/api/habit/draw',{method:'POST',body:{poolId:pool.id},status:400});assert.equal(empty.error,'卡池为空');
    await request('/api/habit/pools/'+pool.id,{method:'DELETE'});
    assert.equal((await request('/api/habit/log')).logs[0].habit,log.habit);
  });
  await t.test('invalid reminders are rejected and notifications are consumed once',async()=>{
    for(const body of [{time:'12:00',content:'  '},{time:'25:99',content:'测试'},{time:'12:00',content:'测试',date:'2026-02-30'}])await request('/api/scheduled',{method:'POST',body,status:400});
    const reminder=await request('/api/scheduled',{method:'POST',body:{time:'12:34',content:'以后提醒我',date:'2099-01-01'}});
    await request('/api/scheduled/test',{method:'POST'});
    assert.equal((await request('/api/scheduled/pending')).pending.length,1);
    assert.deepEqual((await request('/api/scheduled/pending')).pending,[]);
    await request('/api/scheduled/'+reminder.id,{method:'DELETE'});
    assert.deepEqual((await request('/api/scheduled')).tasks,[]);
  });
  await t.test('restore validates selection and files, and can restore a genuinely empty library',async()=>{
    await request('/api/storage/restore',{method:'POST',storage:true,body:{},status:400});
    await request('/api/storage/restore',{method:'POST',storage:true,body:{name:'missing.sqlite'},status:400});
    const bad=new FormData();bad.append('backup',new Blob(['broken']),'broken.sqlite');
    assert.equal((await fetch(base+'/api/storage/restore',{method:'POST',headers:{'X-Memo-Storage':'1'},body:bad})).status,400);
    assert.equal((await request('/api/memos')).length,1);
    await request('/api/storage/restore',{method:'POST',storage:true,body:{name:emptyBackup.name}});
    assert.deepEqual(await request('/api/memos'),[]);assert.deepEqual((await request('/api/habit/pools')).pools,[]);
    assert.deepEqual((await request('/api/habit/log')).logs,[]);
    assert.ok((await request('/api/storage/status')).backups.some(item=>item.name.startsWith('before-restore-')));
    const exported=new AdmZip(Buffer.from(await(await fetch(base+'/api/storage/export')).arrayBuffer()));
    assert.deepEqual(JSON.parse(exported.readAsText('memos.json')).memos,[]);
  });
});
