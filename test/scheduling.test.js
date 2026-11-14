const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const defaults=require('../storage/defaults');

test('scheduled summaries and reminder callbacks use local dates and task locks',{timeout:20000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-schedule-test-'));let child;
  t.after(async()=>{
    if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const fixture=defaults();fixture['memos.json'].memos=[];
  for(const [name,value]of Object.entries(fixture))fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'",fake=path.join(dir,process.platform==='win32' ? 'fake.cmd' : 'fake');
  const cli=path.join(__dirname,'fake-model-cli.js');
  fs.writeFileSync(fake,process.platform==='win32' ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o755});
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,capture=path.join(dir,'calls.jsonl'),marker=path.join(dir,'started');
  child=spawn(process.execPath,['--require',path.join(__dirname,'cron-driver.js'),path.join(__dirname,'../server.js')],{env:{...process.env,MEMO_ELECTRON:'1',MEMO_DATA_DIR:dir,PORT:String(port),TZ:'Asia/Shanghai',CLAUDE_CLI:fake,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_MARKER:marker},stdio:['ignore','pipe','pipe','ipc']});
  let logs='';child.stderr.on('data',data=>{logs+=data;});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(logs)),10000);
    child.stdout.on('data',data=>{logs+=data;if(logs.includes('Memo server running')){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Startup '+code+': '+logs));});
  });
  let sequence=0;
  function drive(action,extra={}) {
    return new Promise((resolve,reject)=>{
      const id=++sequence,timeout=setTimeout(()=>{child.off('message',listener);reject(new Error('Driver timeout'));},5000);
      const listener=message=>{if(message.id!==id)return;clearTimeout(timeout);child.off('message',listener);message.ok ? resolve(message.result) : reject(new Error(message.error));};
      child.on('message',listener);child.send({id,action,...extra});
    });
  }
  async function request(route,body,method=body===undefined ? 'GET' : 'POST') {
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  }
  await t.test('scheduled empty daily and weekly summaries do not invoke a model',async()=>{
    await drive('run',{index:0,now:'2026-11-12T16:30:00Z'});
    let data=await request('/api/cc/suggestions');
    assert.equal(data.dailyDigest.date,'2026-11-13');assert.equal(data.dailyDigest.from,'2026-11-12');assert.equal(data.dailyDigest.empty,true);
    await drive('run',{index:1,now:'2021-01-01T04:00:00Z'});
    data=await request('/api/cc/suggestions');
    assert.equal(data.weeklyDigest.week,'2020-W53');assert.equal(data.weeklyDigest.from,'2020-12-28');assert.equal(data.weeklyDigest.to,'2021-01-03');
    assert.equal(fs.existsSync(capture),false);
  });
  await t.test('changing summary times replaces scheduled jobs instead of duplicating them',async()=>{
    await request('/api/settings',{dailyDigestTime:'22:15',weeklyDigestDay:'monday',weeklyDigestTime:'20:30'},'PUT');
    assert.deepEqual(await drive('jobs'),['15 22 * * *','30 20 * * 1']);
  });
  await t.test('manual and scheduled nonempty daily summaries use the same task and input records',async()=>{
    const memo=await request('/api/memos',{content:'留下今天的一个想法',tags:['创作']});
    await drive('run',{index:0});
    const automatic=await request('/api/cc/suggestions');
    const manual=(await request('/api/cc/ask',{action:'daily-digest'})).digest;
    assert.equal(automatic.dailyDigest.summary,manual.summary);assert.equal(automatic.dailyDigest.from,manual.from);
    const calls=fs.readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,2);assert.ok(calls.every(call=>call.task==='daily-digest' && call.input.records[0].id===memo.id));
  });
  await t.test('scheduled generation respects a running AI task and resumes on a later trigger',async()=>{
    const before=(await request('/api/cc/suggestions')).weeklyDigests.length;
    fs.rmSync(marker,{force:true});const generating=request('/api/cc/ask',{action:'graph'});
    const until=Date.now()+3000;while(!fs.existsSync(marker) && Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(fs.existsSync(marker));await drive('run',{index:1});
    assert.equal((await request('/api/cc/suggestions')).weeklyDigests.length,before);
    assert.match(logs,/Cron.*CC_BUSY/);await generating;
    await drive('run',{index:1});assert.equal((await request('/api/cc/suggestions')).weeklyDigests.length,before+1);
  });
  await t.test('the reminder callback queues once, using the local date, and notifications are consumed once',async()=>{
    const task=await request('/api/scheduled',{date:'2026-11-13',time:'12:34',content:'喝口水吧'});
    const now='2026-11-13T04:34:05Z';
    await drive('reminder',{now});await drive('reminder',{now});
    const pending=(await request('/api/scheduled/pending')).pending;
    assert.equal(pending.length,1);assert.equal(pending[0].id,task.id);
    assert.deepEqual((await request('/api/scheduled/pending')).pending,[]);
    assert.deepEqual((await request('/api/scheduled')).tasks,[]);
  });
});
