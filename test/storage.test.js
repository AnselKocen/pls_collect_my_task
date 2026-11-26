const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const { Store, FILES }=require('../storage/store');
const defaults=require('../storage/defaults');
const resources=new Map();

function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-store-test-'));
  resources.set(dir,[]);
  t.after(() => {
    for (const store of resources.get(dir)) store.close();
    resources.delete(dir);
    fs.rmSync(dir,{recursive:true,force:true});
  });return dir;
}
function open(t,dir=temporary(t)) { const store=new Store(dir);resources.get(dir).push(store);return store; }
function fixture() {
  const data=defaults();
  data['memos.json'].memos=[{id:'m1',content:'中文、Emoji 🌿 和换行\n第二行',tags:['工作','未列入设置的标签','工作'],createdAt:'2024-01-01T00:00:00Z',updatedAt:'2024-01-02T00:00:00Z',pinned:false,custom:{future:true}}];
  data['memos.json'].futureField='preserve';
  data['settings.json'].tags=['工作'];data['settings.json'].customUnknown={keep:42};
  data['habit_pools.json'].pools=[{id:'p1',name:'卡池',habits:['重复卡片','重复卡片','新卡片'],sourceFile:'book.zip',createdAt:'2024-01-01'}];
  data['habit_log.json'].logs=[{id:'l1',poolId:'deleted-pool',poolName:'已删卡池',habit:'历史卡片',date:'2024-01-01',completed:true}];
  data['ai_suggestions.json']={dailyDigest:{summary:'摘要'},weeklyDigest:null,graphHistory:[{id:'g1',nodes:[{id:'n1'}],edges:[],extra:'retained'}],tagSummaries:[],weeklyDigests:[{summary:'旧周报'}],tagSuggestionHistory:[],taskGraph:{legacy:true},unknown:{nested:['x']}};
  data['scheduled_tasks.json']={tasks:[],pending:[{id:'test',message:'one'},{id:'test',message:'two'}],__pendingPresent:'ordinary legacy metadata'};
  return data;
}
function writeFixture(dir,data) { for(const [file,value] of Object.entries(data))fs.writeFileSync(path.join(dir,file),JSON.stringify(value)); }

test('fresh database seeds once and reopening uses SQLite, not stale JSON', t => {
  const dir=temporary(t);let store=new Store(dir);
  assert.equal(store.read('memos').memos.length,6);
  store.update('memos',data=>{data.memos=[];});store.close();
  fs.writeFileSync(path.join(dir,'memos.json'),'not valid JSON');
  store=new Store(dir);assert.equal(store.read('memos').memos.length,0);store.close();
});

test('migration round-trips every field, duplicate cards/tags and orphaned history', t => {
  const dir=temporary(t),source=fixture();writeFixture(dir,source);
  const bytes=Object.fromEntries(Object.values(FILES).map(name=>[name,fs.readFileSync(path.join(dir,name),'utf8')]));
  const store=open(t,dir);
  assert.deepEqual(store.exportLegacy(),source);
  assert.equal(store.status().counts.habit_cards,3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memo_tags').get().n,3);
  for(const [file,text] of Object.entries(bytes))assert.equal(fs.readFileSync(path.join(dir,file),'utf8'),text);
  const backups=fs.readdirSync(store.backupDir);assert.equal(backups.length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.backupDir,backups[0],'memos.json'))),source['memos.json']);
});

test('broken JSON and duplicate IDs fail without committing partial migration; retry succeeds', t => {
  const dir=temporary(t),source=fixture();writeFixture(dir,source);
  fs.writeFileSync(path.join(dir,'habit_log.json'),'{broken');
  assert.throws(()=>new Store(dir),/habit_log.json.*JSON/);
  let inspection=new DatabaseSync(path.join(dir,'memo.sqlite'));
  assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM memos').get().n,0);inspection.close();
  source['memos.json'].memos.push({...source['memos.json'].memos[0]});writeFixture(dir,source);
  assert.throws(()=>new Store(dir),/ID 重复/);
  source['memos.json'].memos.pop();writeFixture(dir,source);
  const store=open(t,dir);assert.deepEqual(store.exportLegacy(),source);
});

test('partial legacy installation does not insert welcome notes or default pools', t => {
  const dir=temporary(t);fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify(defaults()['settings.json']));
  const store=open(t,dir);assert.deepEqual(store.read('memos'),{memos:[]});assert.deepEqual(store.read('pools'),{pools:[]});
});

test('multi-section transaction rolls back settings and associated memo changes', t => {
  const store=open(t),before=store.exportLegacy();
  assert.throws(()=>store.transaction(()=>{
    store.update('settings',data=>{data.tags=['renamed'];});
    store.update('memos',data=>{data.memos=[];});
    throw new Error('simulated write failure');
  }),/simulated/);
  assert.deepEqual(store.exportLegacy(),before);
  assert.throws(()=>store.transaction(()=>Promise.resolve()),/不能等待/);
});

test('per-record writes leave unrelated memo rows untouched', t => {
  const store=open(t);
  store.db.exec("CREATE TRIGGER protect_unrelated BEFORE UPDATE ON memos WHEN OLD.id='welcome-2' BEGIN SELECT RAISE(ABORT,'unrelated row rewritten'); END");
  store.update('memos',data=>{data.memos[0].content='只修改第一条';});
  assert.equal(store.read('memos').memos[0].content,'只修改第一条');
});

test('two connections retain their additions using read-modify-write transactions', t => {
  const dir=temporary(t),a=open(t,dir),b=open(t,dir);
  a.update('memos',data=>{data.memos.push({id:'a',content:'A',tags:[]});});
  b.update('memos',data=>{data.memos.push({id:'b',content:'B',tags:[]});});
  assert.equal(a.read('memos').memos.length,8);
});

test('reminder queue, one-time deletion and duplicate suppression are atomic', t => {
  const store=open(t);
  store.update('scheduled',data=>{data.tasks=[{id:'daily',content:'每天',time:'10:00',date:null},{id:'once',content:'一次',time:'10:00',date:'2026-01-01'}];});
  assert.equal(store.fireReminders('2026-01-01','10:00','2026-01-01T02:00:00Z'),2);
  assert.equal(store.fireReminders('2026-01-01','10:00','2026-01-01T02:00:15Z'),0);
  assert.equal(store.read('scheduled').tasks.length,1);
  const consume=()=>store.update('scheduled',data=>{const pending=data.pending;data.pending=[];return pending;});
  assert.equal(consume().length,2);assert.deepEqual(consume(),[]);
  assert.equal(store.fireReminders('2026-01-02','10:00','2026-01-02T02:00:00Z'),1);
});

test('backup is a complete SQLite snapshot and restore replaces all application data', async t => {
  const dir=temporary(t),source=fixture();writeFixture(dir,source);const store=open(t,dir);
  const saved=await store.createBackup();
  store.update('memos',data=>{data.memos=[];});store.update('suggestions',data=>{data.graphHistory=[];data.unknown='changed';});
  const result=await store.restore(store.backupPath(saved.name));
  assert.deepEqual(store.exportLegacy(),source);
  assert.ok(store.listBackups().some(backup=>backup.name===result.safetyBackup));
  const copy=new DatabaseSync(store.backupPath(result.safetyBackup),{readOnly:true});
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM memos').get().n,0);copy.close();
});

test('corrupt, foreign, and newer backups leave the live data unchanged', async t => {
  const store=open(t),before=store.exportLegacy(),file=path.join(store.dataDir,'bad.sqlite');
  fs.writeFileSync(file,'not a database');await assert.rejects(store.restore(file));fs.unlinkSync(file);
  const other=new DatabaseSync(file);other.exec('CREATE TABLE unrelated (value TEXT)');other.close();
  await assert.rejects(store.restore(file),/当前版本/);fs.unlinkSync(file);
  const saved=await store.createBackup();const newer=new DatabaseSync(store.backupPath(saved.name));newer.exec('PRAGMA user_version=999');newer.close();
  await assert.rejects(store.restore(store.backupPath(saved.name)),/当前版本/);
  assert.deepEqual(store.exportLegacy(),before);
  assert.throws(()=>store.backupPath('../memo.sqlite'),/不存在/);
});

test('automatic backups run at most once per local day and retain seven regular copies', async t => {
  const store=open(t);await store.startupBackup();await store.startupBackup();
  assert.equal(store.listBackups().filter(b=>b.name.startsWith('auto-')).length,1);
  const manual=await store.createBackup();
  for(let i=0;i<10;i++){
    const file=path.join(store.backupDir,`auto-2000-01-${String(i+1).padStart(2,'0')}.sqlite`);
    fs.copyFileSync(store.backupPath(manual.name),file);fs.utimesSync(file,new Date(2000,0,i+1),new Date(2000,0,i+1));
  }
  await store.startupBackup();
  assert.equal(store.listBackups().filter(b=>b.name.startsWith('auto-')).length,7);
  assert.ok(store.listBackups().some(b=>b.name===manual.name));
});

test('v1 database upgrades its date index and v1 backups remain restorable', async t => {
  const dir=temporary(t),source=fixture();
  source['memos.json'].memos[0].createdAt='2026-11-13T00:30:00+08:00';
  writeFixture(dir,source);
  let store=new Store(dir);
  const saved=await store.createBackup();store.close();
  const downgrade=file=>{
    const db=new DatabaseSync(file);
    db.exec('DROP INDEX memos_created_ms; ALTER TABLE memos DROP COLUMN created_ms; PRAGMA user_version=1');db.close();
  };
  downgrade(path.join(dir,'memo.sqlite'));downgrade(path.join(dir,'backups',saved.name));
  store=new Store(dir);resources.get(dir).push(store);
  assert.equal(store.status().version,2);
  assert.deepEqual(store.queryMemos({start:'2026-11-12T16:00:00Z',end:'2026-11-13T16:00:00Z'}).map(m=>m.id),['m1']);
  store.update('memos',data=>{data.memos=[];});
  await store.restore(store.backupPath(saved.name));
  assert.deepEqual(store.exportLegacy(),source);
  assert.equal(store.queryMemos({start:'2026-11-12T16:00:00Z'}).length,1);
});
