const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const { spawn }=require('node:child_process');
const { once }=require('node:events');
const AdmZip=require('adm-zip');
const defaults=require('../storage/defaults');

async function freePort() {
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}
async function launch(children,dir,port,extra={}) {
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,MEMO_DATA_DIR:dir,MEMO_ELECTRON:'1',PORT:String(port),...extra},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',data=>{logs+=data;});
  children.push(child);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Server startup timeout: ${logs}`)),10000);
    child.stdout.on('data',data=>{logs+=data;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${logs}`));});
  });return child;
}

test('API compatibility, AI history races, backup/export/restore and restart', {timeout:30000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-api-test-'));
  const children=[];
  t.after(async()=>{
    for(const child of children) if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const fixture=defaults();fixture['ai_suggestions.json'].graphHistory=[{id:'old-graph',nodes:[],edges:[],summaries:[],insights:''}];
  for(const [file,value] of Object.entries(fixture))fs.writeFileSync(path.join(dir,file),JSON.stringify(value));
  const fake=path.join(dir,process.platform==='win32' ? 'fake-claude.cmd' : 'fake-claude'),marker=path.join(dir,'cc-started');
  const cli=path.join(__dirname,'fake-model-cli.js');
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  const script=process.platform==='win32' ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
  fs.writeFileSync(fake,script,{mode:0o755});
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const capture=path.join(dir,'calls.jsonl'),invalid=path.join(dir,'invalid-mode');
  let child=await launch(children,dir,port,{CLAUDE_CLI:fake,MEMO_FAKE_CC_MARKER:marker,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_INVALID_FILE:invalid});
  async function request(route,{method='GET',body,storage=false,expected=200}={}){
    const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(storage)headers['X-Memo-Storage']='1';
    const res=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data;
  }
  assert.equal((await request('/api/memos')).length,5);
  await request('/api/tags',{method:'POST',body:{tag:'测试',emoji:'🌿'}});
  const memo=await request('/api/memos',{method:'POST',body:{content:'数据库的中文记录 🌿',tags:['测试']}});
  await request(`/api/memos/${memo.id}`,{method:'PUT',body:{pinned:true}});
  assert.equal((await request('/api/memos?keyword='+encodeURIComponent('中文')))[0].id,memo.id);
  await request('/api/tags/'+encodeURIComponent('测试'),{method:'PUT',body:{newTag:'重命名'}});
  assert.deepEqual((await request('/api/memos?tag='+encodeURIComponent('重命名')))[0].tags,['重命名']);
  await request(`/api/memos/${memo.id}`,{method:'PUT',body:{tags:['重命名','含,逗号']}});
  assert.deepEqual((await request('/api/memos?tags='+encodeURIComponent(JSON.stringify(['含,逗号'])))).map(item=>item.id),[memo.id]);
  await request(`/api/memos/${memo.id}`,{method:'PUT',body:{tags:['重命名']}});
  await request('/api/settings',{method:'PUT',body:{theme:'mint',dailyDigestTime:'18:30'}});
  const settings=await request('/api/settings');assert.equal(settings.theme,'mint');
  await request('/api/settings',{method:'PUT',body:{dailyDigestTime:'bad'},expected:500});
  assert.equal((await request('/api/settings')).dailyDigestTime,'18:30');

  const draw=await request('/api/habit/draw',{method:'POST',body:{poolId:'default-pool'}});
  await request(`/api/habit/log/${draw.log.id}/complete`,{method:'PUT'});
  assert.equal((await request('/api/habit/log?date='+draw.log.date)).logs[0].completed,true);
  const month=draw.log.date.slice(0,7).split('-');
  assert.equal((await request(`/api/habit/calendar?year=${month[0]}&month=${Number(month[1])}`)).calendar[draw.log.date],'completed');
  await request('/api/habit/pools/default-pool',{method:'PUT',body:{name:'保留历史',habits:['新卡片']}});
  await request('/api/habit/pools/default-pool',{method:'DELETE'});
  assert.equal((await request('/api/habit/log')).logs[0].habit,draw.log.habit);

  const reminder=await request('/api/scheduled',{method:'POST',body:{content:'提醒测试',time:'12:34',date:'2099-01-01'}});
  assert.ok((await request('/api/scheduled')).tasks.some(task=>task.id===reminder.id));
  await request('/api/scheduled/test',{method:'POST'});await request('/api/scheduled/test',{method:'POST'});
  assert.equal((await request('/api/scheduled/pending')).pending.length,2);
  assert.equal((await request('/api/scheduled/pending')).pending.length,0);

  const generating=request('/api/cc/ask',{method:'POST',body:{action:'graph',params:{}}});
  const until=Date.now()+5000;while(!fs.existsSync(marker)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(marker));
  const callsBeforeSearch=fs.readFileSync(capture,'utf8').trim().split('\n').length;
  assert.equal((await request('/api/memos?keyword='+encodeURIComponent('记录 数据库')+'&mode=fuzzy'))[0].id,memo.id);
  const localCompatibility=await request('/api/cc/ask',{method:'POST',body:{action:'search',params:{query:'中文'}}});
  assert.deepEqual(localCompatibility.results,[memo.id]);
  assert.equal(fs.readFileSync(capture,'utf8').trim().split('\n').length,callsBeforeSearch);
  await request('/api/cc/graph/old-graph',{method:'DELETE'});
  await request('/api/storage/restore',{method:'POST',storage:true,body:{name:'missing.sqlite'},expected:409});
  await generating;
  const graphs=(await request('/api/cc/suggestions')).graphHistory;
  assert.equal(graphs.length,1);assert.ok(graphs[0].nodes.length);assert.notEqual(graphs[0].id,'old-graph');
  assert.equal(graphs[0].coverage.processedCount,6);
  assert.ok(graphs[0].nodes.every(node=>node.memoIds.length===1));
  fs.writeFileSync(invalid,'graph');
  await request('/api/cc/ask',{method:'POST',body:{action:'graph'},expected:400});
  assert.equal((await request('/api/cc/suggestions')).graphHistory.length,1);
  fs.unlinkSync(invalid);
  const daily=await request('/api/cc/ask',{method:'POST',body:{action:'daily-digest',params:{tags:['重命名']}}});
  assert.match(daily.digest.date,/^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(daily.digest.tagTrends,{'重命名':1});
  const weekly=await request('/api/cc/ask',{method:'POST',body:{action:'weekly-digest',params:{tags:['重命名']}}});
  assert.match(weekly.digest.week,/^\d{4}-W\d{2}$/);
  assert.equal((await request('/api/cc/suggestions')).weeklyDigests[0].from,weekly.digest.from);
  const tagSuggestions=await request('/api/cc/ask',{method:'POST',body:{action:'tag-suggestions'}});
  assert.equal(tagSuggestions.coverage.processedCount,6);

  const status=await request('/api/storage/status');assert.equal(status.counts.memos,6);
  await request('/api/storage/backup',{method:'POST',expected:403});
  const hostile=await fetch(base+'/api/storage/backup',{method:'POST',headers:{Origin:'https://untrusted.example','X-Memo-Storage':'1'}});assert.equal(hostile.status,403);
  const saved=await request('/api/storage/backup',{method:'POST',storage:true});
  const download=await fetch(base+'/api/storage/backups/'+saved.name);assert.equal(download.status,200);
  const snapshot=Buffer.from(await download.arrayBuffer());assert.equal(snapshot.subarray(0,15).toString(),'SQLite format 3');
  const exported=new AdmZip(Buffer.from(await(await fetch(base+'/api/storage/export')).arrayBuffer()));
  assert.equal(JSON.parse(exported.readAsText('memos.json')).memos.length,6);
  assert.equal(JSON.parse(exported.readAsText('settings.json')).theme,'mint');
  assert.ok(exported.getEntry('ai_suggestions.json'));
  await request(`/api/memos/${memo.id}`,{method:'DELETE'});
  assert.equal((await request('/api/memos')).length,5);
  await request('/api/storage/restore',{method:'POST',storage:true,body:{name:saved.name}});
  assert.equal((await request('/api/memos')).length,6);
  const malformed=new FormData();malformed.append('backup',new Blob(['broken']),'broken.sqlite');
  const bad=await fetch(base+'/api/storage/restore',{method:'POST',headers:{'X-Memo-Storage':'1'},body:malformed});assert.equal(bad.status,400);
  assert.equal((await request('/api/memos')).length,6);
  const form=new FormData();form.append('backup',new Blob([snapshot]),'backup.sqlite');
  const restored=await fetch(base+'/api/storage/restore',{method:'POST',headers:{'X-Memo-Storage':'1'},body:form});assert.equal(restored.status,200);
  assert.equal(fs.readdirSync(path.join(dir,'restore_upload')).length,0);

  // An occupied server port must prevent migration of another directory.
  const other=path.join(dir,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'memos.json'),'broken');
  const duplicate=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,MEMO_ELECTRON:'1',MEMO_DATA_DIR:other,PORT:String(port)},stdio:'ignore'});
  children.push(duplicate);
  const [code]=await once(duplicate,'exit');assert.notEqual(code,0);assert.equal(fs.existsSync(path.join(other,'memo.sqlite')),false);

  child.kill('SIGTERM');await once(child,'close');
  fs.writeFileSync(path.join(dir,'memos.json'),'stale broken JSON is not reimported');
  child=await launch(children,dir,port);
  assert.equal((await request('/api/memos')).length,6);
  assert.equal((await request('/api/settings')).theme,'mint');
  assert.equal((await request('/api/habit/log')).logs[0].completed,true);
  await request('/api/tags/'+encodeURIComponent('重命名'),{method:'DELETE'});
  assert.equal((await request('/api/memos')).length,5); // Existing tag deletion semantics.
});
