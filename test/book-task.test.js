const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const AdmZip=require('adm-zip'),{fixture}=require('./agent-fixture');

test('book generation reports validation and commit failures, preserves preview, and keeps filename text',{timeout:30000},async t=>{
  const f=fixture(t),dataDir=path.join(f.dir,'data');fs.mkdirSync(dataDir);
  const seed=require('../storage/defaults')();seed['settings.json'].agent='cc';seed['habit_pools.json'].pools=[];
  for(const [name,value]of Object.entries(seed))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const instanceId='fictional-book-test-instance',base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...f.env,MEMO_DATA_DIR:dataDir,MEMO_ELECTRON:'1',MEMO_INSTANCE_ID:instanceId,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',data=>logs+=data);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code+': '+logs));});});
  async function get(route){const response=await fetch(base+route);assert.equal(response.status,200);return response.json();}
  async function upload(name='fictional-book.zip',status=200){
    const zip=new AdmZip();zip.addFile('book.txt',Buffer.from('虚构读本：观察窗边光线，整理桌面，阅读一页。'));
    const body=new FormData();body.append('zipFile',new Blob([zip.toBuffer()]),name);
    const response=await fetch(base+'/api/habit/pools/generate',{method:'POST',body});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  const pools=async()=>(await get('/api/habit/pools')).pools;
  async function failedWithoutSave(work,error){
    const before=await pools(),response=await work();const task=(await get('/api/ai/task')).task;
    assert.match(response.error,error);assert.equal(task.status,'failed');assert.ok(task.error);assert.notEqual(task.stage,'已完成并保存');
    assert.ok(task.messages.some(message=>message.text),'Keep the public preview after a failed result');
    assert.deepEqual(await pools(),before);assert.equal((await get('/api/ai/status')).busy,false);
  }
  await t.test('invalid book result is failed rather than completed and can be retried',async()=>{
    fs.writeFileSync(f.mode,'empty:habit-pool');try{await failedWithoutSave(()=>upload('empty.zip',500),/可用|习惯|生成/);}finally{fs.rmSync(f.mode,{force:true});}
    const {pool}=await upload();assert.equal(pool.habits.length,30);
    const task=(await get('/api/ai/task')).task;assert.equal(task.status,'completed');assert.equal(task.stage,'已完成并保存');
  });
  await t.test('malformed JSON leaves history and pools unchanged',async()=>{
    fs.writeFileSync(f.mode,'habit-pool');try{await failedWithoutSave(()=>upload('malformed.zip',500),/格式|生成/);}finally{fs.rmSync(f.mode,{force:true});}
  });
  await t.test('database commit failure cannot produce a successful task',async()=>{
    const db=new DatabaseSync(path.join(dataDir,'memo.sqlite'));
    db.exec("CREATE TRIGGER reject_pool_for_test BEFORE INSERT ON habit_pools BEGIN SELECT RAISE(ABORT,'fictional save failure'); END");db.close();
    try{await failedWithoutSave(()=>upload('save-failure.zip',500),/保存|失败|生成/);}
    finally{const db=new DatabaseSync(path.join(dataDir,'memo.sqlite'));db.exec('DROP TRIGGER reject_pool_for_test');db.close();}
    assert.equal((await upload()).pool.habits.length,30);
  });
  await t.test('ASCII Chinese and emoji filenames round-trip and persist',async()=>{
    for(const name of ['book.zip','虚构读本.zip','笔记🌿.zip']){
      const {pool}=await upload(name);assert.equal(pool.sourceFile,name);
      assert.equal((await pools()).find(row=>row.id===pool.id).sourceFile,name);
    }
    const db=new DatabaseSync(path.join(dataDir,'memo.sqlite'),{readOnly:true});
    const sourceNames=db.prepare('SELECT payload FROM habit_pools ORDER BY position').all().map(row=>JSON.parse(row.payload).sourceFile);db.close();
    assert.deepEqual(sourceNames.slice(-3),['book.zip','虚构读本.zip','笔记🌿.zip']);
  });
  await t.test('local health identifies the actual instance without exposing the data path',async()=>{
    const health=await get('/api/health');assert.equal(health.application,'memo-journal');assert.equal(health.protocol,1);assert.equal(health.pid,child.pid);assert.equal(health.instanceId,instanceId);assert.equal(health.ready,true);
    assert.equal(health.dataId,createHash('sha256').update(path.resolve(dataDir)).digest('hex'));assert.equal(health.path,undefined);
    const status=await new Promise((resolve,reject)=>{const request=require('node:http').get(base+'/api/health',{headers:{Host:'untrusted.example'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);});assert.equal(status,403);
  });
});
