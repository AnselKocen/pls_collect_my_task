const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const {fixture}=require('./agent-fixture');

test('all manual and scheduled task types replace one durable latest reply and retain exact result targets',{timeout:45000},async t=>{
  const f=fixture(t),dataDir=path.join(f.dir,'data');fs.mkdirSync(dataDir);
  const seed=require('../storage/defaults')();seed['settings.json'].agent='codex';seed['habit_pools.json'].pools=[];
  for(const [name,value]of Object.entries(seed))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,logFile=path.join(dataDir,'latest-ai-task.json');
  let child,logs='',sequence=0;
  async function stop(){if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
  t.after(stop);
  async function start(){
    logs='';child=spawn(process.execPath,['--require',path.join(__dirname,'cron-driver.js'),path.join(__dirname,'../server.js')],{
      env:{...f.env,PORT:String(port),MEMO_DATA_DIR:dataDir,MEMO_ELECTRON:'1'},stdio:['ignore','pipe','pipe','ipc']});
    child.stderr.on('data',chunk=>logs+=chunk);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(logs)),10000);
      child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup '+code+': '+logs));});
    });
  }
  async function request(route,body,{method=body===undefined?'GET':'POST',status=200,storage=false}={}){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(storage?{'X-Memo-Storage':'1'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status);return response.json();
  }
  const latest=async()=>(await request('/api/ai/task')).task;
  const saved=()=>JSON.parse(fs.readFileSync(logFile,'utf8')).task;
  async function ask(action){return request('/api/cc/ask',{action});}
  async function wish(input){
    const response=await fetch(base+'/api/habit/wish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status,200);const frames=await response.text();
    const event=name=>{const match=new RegExp('event: '+name+'\\ndata: ([^\\n]+)').exec(frames);return match?JSON.parse(match[1]):undefined;};
    return {result:event('result'),error:event('error')};
  }
  function drive(index){return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>reject(new Error('Cron timeout')),10000);
    const receive=message=>{if(message.id!==id)return;clearTimeout(timer);child.off('message',receive);message.ok?resolve():reject(new Error(message.error));};
    child.on('message',receive);child.send({id,action:'run',index});
  });}
  await start();assert.equal(await latest(),null);
  let previousId;
  for(const action of ['daily-digest','weekly-digest','tag-suggestions','graph']){
    const result=await ask(action),task=await latest();
    assert.equal(task.target.type,action);assert.equal(task.status,'completed');assert.notEqual(task.id,previousId);previousId=task.id;
    const generatedAt=action==='graph'?result.graph.generatedAt:action==='tag-suggestions'?result.generatedAt:result.digest.generatedAt;
    assert.ok(generatedAt);assert.equal(task.target.generatedAt,generatedAt);
    if(action==='graph')assert.equal(task.target.id,result.graph.id);
    if(action==='tag-suggestions')assert.equal((await request('/api/cc/suggestions')).tagSuggestionHistory[0].generatedAt,generatedAt);
    assert.ok(task.messages.length);assert.equal(new Set(task.messages.map(message=>message.id)).size,task.messages.length);
    assert.deepEqual(saved().messages,task.messages);assert.equal(saved().id,task.id);
    assert.doesNotMatch(fs.readFileSync(logFile,'utf8'),/PRIVATE_THINKING/);
  }
  await drive(0);assert.equal((await latest()).target.type,'daily-digest');assert.notEqual((await latest()).id,previousId);
  await drive(1);assert.equal((await latest()).target.type,'weekly-digest');

  fs.writeFileSync(f.mode,'slow');
  const material=request('/api/habit/pools/generate',{text:'观察植物，整理桌面，阅读一页。'});
  for(let i=0;i<150 && !(await request('/api/ai/status')).busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual((await latest()).target,{type:'habit-pool',source:'material'});
  const {pool:materialPool}=await material;fs.rmSync(f.mode);
  assert.deepEqual((await latest()).target,{type:'habit-pool',source:'material',id:materialPool.id,generatedAt:materialPool.createdAt});

  const input={stage:'generate',wish:'观察生活',purpose:'保留细节',effort:'每天五分钟',requestId:randomUUID()};
  const before=(await request('/api/habit/pools')).pools;
  fs.writeFileSync(f.mode,'duplicate:habit-wish-pool');const failed=await wish(input);fs.rmSync(f.mode);
  assert.ok(failed.error);assert.equal((await latest()).status,'failed');
  assert.deepEqual((await latest()).target,{type:'habit-pool',source:'wish',step:'generate'});
  assert.deepEqual((await request('/api/habit/pools')).pools,before);assert.ok(saved().messages.length);
  const generated=await wish(input);assert.equal(generated.result.pool.habits.length,30);
  const complete=await latest();assert.equal(complete.target.id,generated.result.pool.id);assert.equal(complete.messages.length,1);
  assert.deepEqual(JSON.parse(complete.messages[0].text).habits,generated.result.pool.habits);

  await stop();await start();
  const recovered=await latest();assert.equal(recovered.status,'completed');assert.equal(recovered.id,complete.id);
  assert.equal((await request('/api/ai/status')).busy,false);assert.deepEqual(recovered.messages,complete.messages);
  await stop();
  const unfinished=saved();unfinished.status='running';unfinished.finishedAt=null;unfinished.stage='正在保存习惯卡池';
  fs.writeFileSync(logFile,JSON.stringify({version:1,task:unfinished}));
  await start();const interrupted=await latest();
  assert.equal(interrupted.status,'failed');assert.equal(interrupted.interrupted,true);assert.match(interrupted.error,/完成状态未确认/);
  assert.equal((await request('/api/ai/status')).busy,false);assert.equal(interrupted.target.id,generated.result.pool.id);
  assert.ok((await request('/api/habit/pools')).pools.some(pool=>pool.id===interrupted.target.id),'a saved pool remains saved even if its last task was interrupted');
  const backup=await request('/api/storage/backup',{}, {storage:true});
  await request('/api/storage/restore',{name:backup.name},{storage:true});
  assert.equal(await latest(),null);assert.equal(saved(),null);
  assert.deepEqual(fs.readdirSync(dataDir).filter(name=>name.startsWith('latest-ai-task')),['latest-ai-task.json']);
});
