const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const AdmZip = require('adm-zip');
const {fixture} = require('./agent-fixture');

test('agent selection persists and locks every manual, scheduled and habit task',{timeout:40000},async t => {
  const f = fixture(t), dataDir = path.join(f.dir,'data');fs.mkdirSync(dataDir);
  const defaults = require('../storage/defaults')();
  delete defaults['settings.json'].agent; // Existing databases have no preference.
  for (const [file,value] of Object.entries(defaults)) fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const probe = net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`, marker = path.join(f.dir,'started');
  let child,logs='',sequence=0;
  const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {child.kill('SIGTERM');await once(child,'close');}
  }
  t.after(stop);
  async function start() {
    child = spawn(process.execPath,['--require',path.join(__dirname,'cron-driver.js'),path.join(__dirname,'../server.js')],{
      env:{...f.env,MEMO_DATA_DIR:dataDir,MEMO_FAKE_CC_MARKER:marker,MEMO_ELECTRON:'1',PORT:String(port)},stdio:['ignore','pipe','pipe','ipc']
    });
    logs='';child.stderr.on('data',chunk => {logs+=chunk;});
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error(logs)),10000);
      child.stdout.on('data',chunk => {logs+=chunk;if(logs.includes('Memo server running')) {clearTimeout(timer);resolve();}});
      child.once('exit',code => {clearTimeout(timer);reject(new Error('Startup '+code+': '+logs));});
    });
  }
  async function request(route,{method='GET',body,status=200,headers={}}={}) {
    const response = await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
  }
  const select = (agent,status=200) => request('/api/settings',{method:'PUT',body:{agent},status});
  const calls = () => fs.existsSync(f.capture) ? fs.readFileSync(f.capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function started() {
    for (let count=0;count<150 && !fs.existsSync(marker);count++) await delay(10);
    assert.equal(fs.existsSync(marker),true);
  }
  function drive(index) {
    return new Promise((resolve,reject) => {
      const id=++sequence,timer=setTimeout(() => reject(new Error('Cron timeout')),10000);
      const receive = message => {if(message.id!==id)return;clearTimeout(timer);child.off('message',receive);message.ok ? resolve() : reject(new Error(message.error));};
      child.on('message',receive);child.send({id,action:'run',index});
    });
  }
  await start();
  assert.equal((await request('/api/settings')).agent,'cc');
  for (const agent of ['',null,[],{},'constructor','workbuddy']) await select(agent,400);
  assert.equal((await request('/api/settings')).agent,'cc');

  await select('codex');
  fs.rmSync(marker,{force:true});
  const graph = request('/api/cc/ask',{method:'POST',body:{action:'graph'}});
  await started();
  const working = await request('/api/ai/status');assert.equal(working.busy,true);assert.equal(working.agent,'codex');
  assert.equal(typeof working.startedAt,'number');assert.ok(working.elapsedMs>=0);
  await select('codebuddy',409);
  await request('/api/ai/path',{method:'POST',body:{agent:'codex',path:f.env.CODEX_CLI},headers:{'X-Memo-AI':'1'},status:409});
  await request('/api/settings',{method:'PUT',body:{theme:'mint'}}); // Only agent changes are blocked.
  assert.equal((await request('/api/settings')).agent,'codex');
  assert.ok((await graph).graph.nodes.length);
  assert.equal(calls().at(-1).agent,'codex');
  assert.equal((await request('/api/ai/status')).busy,false);
  assert.equal((await request('/api/ai/status')).startedAt,null);

  await select('codebuddy');
  const zip = new AdmZip();zip.addFile('book.txt',Buffer.from('每天写一点记录。'));
  const form = new FormData();form.append('zipFile',new Blob([zip.toBuffer()]),'book.zip');
  fs.rmSync(marker,{force:true});
  const habit = fetch(base+'/api/habit/pools/generate',{method:'POST',body:form});
  await started();await select('cc',409);
  const habitResponse = await habit;assert.equal(habitResponse.status,200);
  assert.equal((await habitResponse.json()).pool.habits.length,30);
  assert.equal(calls().at(-1).agent,'codebuddy');

  fs.rmSync(marker,{force:true});
  const scheduled = drive(0);await started();await select('cc',409);await scheduled;
  assert.equal(calls().at(-1).agent,'codebuddy');assert.equal(calls().at(-1).task,'daily-digest');

  const closed=await select('trae',400);assert.match(closed.error,/AGENT_DISABLED:trae/);
  assert.equal((await request('/api/ai/status')).agent,'codebuddy');
  await select('cc');
  assert.equal((await request('/api/ai/status')).name,'Claude Code');
  assert.ok((await request('/api/cc/ask',{method:'POST',body:{action:'graph'}})).graph.nodes.length);
  assert.equal(calls().at(-1).agent,'cc');
  await drive(0);
  assert.equal(calls().at(-1).agent,'cc');assert.equal(calls().at(-1).task,'daily-digest');

  fs.writeFileSync(f.mode,'partial-failure');
  await request('/api/cc/ask',{method:'POST',body:{action:'graph'},status:400});
  assert.equal((await request('/api/ai/status')).busy,false);
  fs.rmSync(f.mode);
  await select('codex');
  fs.renameSync(f.env.CODEX_CLI,f.env.CODEX_CLI+'.saved');
  assert.equal((await request('/api/ai/status')).configured,false);
  await request('/api/cc/ask',{method:'POST',body:{action:'graph'},status:400});
  assert.equal((await request('/api/ai/status')).busy,false);
  fs.renameSync(f.env.CODEX_CLI+'.saved',f.env.CODEX_CLI);

  await select('codebuddy');await stop();await start();
  assert.equal((await request('/api/settings')).agent,'codebuddy');
  const backup = await request('/api/storage/backup',{method:'POST',headers:{'X-Memo-Storage':'1'}});
  await select('cc');
  await request('/api/storage/restore',{method:'POST',body:{name:backup.name},headers:{'X-Memo-Storage':'1'}});
  assert.equal((await request('/api/ai/status')).agent,'codebuddy');
  assert.equal((await request('/api/ai/status')).busy,false);

  // A viewer can disconnect/reopen while the same task continues behind it.
  fs.writeFileSync(f.mode,'stream-slow');
  const firstController=new AbortController();
  const stream=await fetch(base+'/api/ai/events',{signal:firstController.signal});
  assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader=stream.body.getReader(),decoder=new TextDecoder();let frames='';
  const collecting=(async()=>{try {while(true){const {value,done}=await reader.read();if(done)break;frames+=decoder.decode(value,{stream:true});}}catch(error){if(error.name!=='AbortError')throw error;}})();
  const generating=request('/api/cc/ask',{method:'POST',body:{action:'graph'}});
  for(let i=0;i<200 && !frames.includes('"type":"delta"');i++)await delay(10);
  assert.ok(frames.includes('"type":"delta"'),'Expected deltas before generation response');
  assert.equal((await request('/api/ai/status')).busy,true);
  firstController.abort();await collecting;
  const secondController=new AbortController();
  const reopened=await fetch(base+'/api/ai/events',{signal:secondController.signal});
  const secondReader=reopened.body.getReader();let replay='';
  while(!replay.includes('"messages":[')){const chunk=await secondReader.read();replay+=decoder.decode(chunk.value,{stream:true});}
  assert.match(replay,/"status":"running"/);assert.match(replay,/"text":".+/);
  await select('cc',409);await generating;
  secondController.abort();await secondReader.cancel().catch(()=>{});
  const snapshotResponse=await fetch(base+'/api/ai/task');
  assert.equal(snapshotResponse.headers.get('cache-control'),'no-store');
  const snapshot=await snapshotResponse.json(),savedTask=snapshot.task;
  assert.ok(snapshot.streamId);assert.ok(snapshot.revision>0);
  assert.equal(savedTask.status,'completed');assert.ok(savedTask.messages[0].text.length>0);assert.doesNotMatch(JSON.stringify(savedTask),/PRIVATE_THINKING/);
  fs.rmSync(f.mode);
  const foreign=await fetch(base+'/api/ai/events',{headers:{Origin:'https://untrusted.example'}});assert.equal(foreign.status,403);
});

test('historical Trae settings and backups fall back without exposing or invoking Trae',{timeout:30000},async t=>{
  const f=fixture(t),dataDir=path.join(f.dir,'legacy-data');fs.mkdirSync(dataDir);
  const defaults=require('../storage/defaults')();defaults['settings.json'].agent='trae';
  for(const [file,value]of Object.entries(defaults))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;let child,output='';
  async function stop(){if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
  t.after(stop);
  async function start(){
    output='';child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...f.env,MEMO_DATA_DIR:dataDir,MEMO_ELECTRON:'1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(output)),10000);
      child.stderr.on('data',value=>{output+=value;});
      child.stdout.on('data',value=>{output+=value;if(output.includes('Memo server running')){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});
    });
  }
  async function request(route,{method='GET',body,status=200,headers={}}={}){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  }
  await start();
  assert.equal((await request('/api/settings')).agent,'codex');
  assert.equal((await request('/api/ai/status')).agent,'codex');
  assert.equal((await request('/api/settings',{method:'PUT',body:{theme:'mint'}})).agent,'codex');
  const closed=await request('/api/settings',{method:'PUT',body:{agent:'trae'},status:400});assert.match(closed.error,/AGENT_DISABLED:trae/);
  const html=await (await fetch(base+'/')).text();assert.doesNotMatch(html,/<option[^>]*value=["']trae["']/);
  const backup=await request('/api/storage/backup',{method:'POST',headers:{'X-Memo-Storage':'1'}});
  await request('/api/settings',{method:'PUT',body:{agent:'codebuddy'}});
  await request('/api/storage/restore',{method:'POST',body:{name:backup.name},headers:{'X-Memo-Storage':'1'}});
  assert.equal((await request('/api/ai/status')).agent,'codex');
  await stop();await start();assert.equal((await request('/api/settings')).agent,'codex');
  fs.writeFileSync(f.mode,'stream-slow');
  const generating=request('/api/cc/ask',{method:'POST',body:{action:'graph'}});
  for(let i=0;i<200 && !(await request('/api/ai/status')).busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await request('/api/ai/status')).busy,true);
  await request('/api/settings',{method:'PUT',body:{agent:'codex'}});
  await request('/api/settings',{method:'PUT',body:{agent:'codebuddy'},status:409});
  assert.ok((await generating).graph.nodes.length);
  const calls=fs.readFileSync(f.capture,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length);assert.ok(calls.every(call=>call.agent==='codex'));
});
