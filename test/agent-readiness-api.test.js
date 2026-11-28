const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {fixture} = require('./agent-fixture');

test('startup readiness is cached and prompt-free; explicit tests share the AI lock without changing settings or notes',{timeout:40000},async t => {
  const f=fixture(t),dataDir=path.join(f.dir,'data');
  fs.mkdirSync(dataDir);
  const initial=require('../storage/defaults')();
  for(const [name,value] of Object.entries(initial))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  let child,logs='';
  async function stop() {if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
  t.after(stop);
  async function start() {
    logs='';
    child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...f.env,MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,PORT:String(port)},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(logs)),10000);
      child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});
      child.stderr.on('data',chunk=>{logs+=chunk;});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Startup ${code}: ${logs}`));});
    });
  }
  async function request(route,{body,headers={},status=200}={}) {
    const response=await fetch(base+route,{method:body===undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
  }
  const headers={'X-Memo-AI':'1'};
  const calls=()=>fs.existsSync(f.capture) ? fs.readFileSync(f.capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function settled() {
    for(let i=0;i<150;i++){const state=await request('/api/ai/readiness');if(!state.checking && state.checkedAt)return state;await pause(30);}
    throw new Error('Readiness check never settled');
  }
  await start();
  const first=await settled();
  assert.equal(first.version,require('../package.json').version);
  assert.match(first.serviceId,/^[\da-f-]{36}$/);
  assert.deepEqual(first.agents.map(row=>[row.id,row.state,row.canTest]),[['cc','detected',true],['codex','detected',true],['codebuddy','unknown',true]]);
  const serialized=JSON.stringify(first);
  assert.ok(!serialized.includes(f.dir));
  assert.ok(!/Logged in using|authMethod|access_token|api_key|@/.test(serialized));
  assert.equal(calls().length,0,'Startup never submits a model prompt');
  for(let i=0;i<3;i++)assert.equal((await request('/api/ai/readiness')).checkedAt,first.checkedAt);
  await request('/api/ai/readiness/refresh',{body:{},status:403});
  await request('/api/ai/readiness/test',{body:{agent:'cc'},status:403});
  await request('/api/ai/readiness/test',{body:{agent:'cc'},headers:{...headers,Origin:'https://example.invalid'},status:403});
  await request('/api/ai/readiness/test',{body:{agent:'trae'},headers,status:400});
  await request('/api/ai/readiness/refresh',{body:{},headers});
  assert.equal(calls().length,0,'Manual basic refresh remains prompt-free');
  const before=await request('/api/memos');
  assert.equal((await request('/api/settings')).agent,'cc');
  const existingLog=await request('/api/ai/task');
  fs.writeFileSync(f.mode,'slow');
  const connection=request('/api/ai/readiness/test',{body:{agent:'codex'},headers});
  for(let i=0;i<100 && !(await request('/api/ai/status')).busy;i++)await pause(15);
  const working=await request('/api/ai/status');assert.equal(working.busy,true);assert.match(working.task,/Codex/);
  await request('/api/ai/readiness/test',{body:{agent:'cc'},headers,status:409});
  await request('/api/ai/readiness/refresh',{body:{},headers,status:409});
  await request('/api/cc/ask',{body:{action:'graph'},status:409});
  const switched=await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:'codebuddy'})});assert.equal(switched.status,409);
  const finished=await connection;
  assert.equal(finished.agents.find(row=>row.id==='codex').test.state,'success');
  assert.equal((await request('/api/ai/status')).busy,false);
  assert.equal((await request('/api/settings')).agent,'cc','Testing another assistant never switches the selected assistant');
  assert.deepEqual(await request('/api/memos'),before);
  assert.deepEqual((await request('/api/ai/task')).task,existingLog.task,'Connection test leaves journal task history untouched');
  const sent=calls();assert.equal(sent.length,1);assert.equal(sent[0].task,'connection-test');
  assert.deepEqual(Object.keys(sent[0].input),['prompt']);
  assert.ok(!sent[0].input.prompt.includes(initial['memos.json'].memos[0].content));
  fs.rmSync(f.mode);
  fs.renameSync(f.env.CODEX_CLI,f.env.CODEX_CLI+'.saved');
  const refreshed=await request('/api/ai/readiness/refresh',{body:{},headers});
  assert.equal(refreshed.agents.find(row=>row.id==='codex').state,'missing');
  await request('/api/ai/readiness/test',{body:{agent:'codex'},headers,status:400});
  assert.equal(calls().length,1);
  await stop();await start();
  const restarted=await settled();assert.notEqual(restarted.serviceId,first.serviceId);
  assert.equal(calls().length,1,'Restart only performs basic checks');
});
