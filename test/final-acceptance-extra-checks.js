// Isolated final acceptance: simulate only Claude Code model output.
// Real Express server, multipart upload, ZIP extraction and SQLite persistence.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),net=require('node:net');
const assert=require('node:assert/strict');
const AdmZip=require('adm-zip'),defaults=require('../storage/defaults');
const evidence=path.join(__dirname,'final-acceptance-evidence/2026-11-25-run-01/db');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'memo-final-extra-')),data=path.join(work,'data');fs.mkdirSync(data);
const responseFile=path.join(work,'model-response.json'),cli=path.join(work,'model-cli.cjs'),launcher=path.join(work,'claude-sim');
const quote=v=>"'"+v.replace(/'/g,"'\\''")+"'";
fs.writeFileSync(cli,"const fs=require('node:fs');if(process.argv.includes('--version')){console.log('Claude controlled fixture');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>{const text=fs.readFileSync(process.env.MEMO_EXTRA_RESPONSE,'utf8');fs.appendFileSync(process.env.MEMO_EXTRA_CALLS,'call\\n');for(const event of [{type:'assistant',message:{id:'fixture',content:[{type:'text',text}]}},{type:'result',subtype:'success',is_error:false,result:text}])console.log(JSON.stringify(event));});");
fs.writeFileSync(launcher,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(cli)+' "$@"\n',{mode:0o755});
const docs=defaults();docs['habit_pools.json'].pools=[];docs['memos.json'].memos=[];docs['settings.json'].agent='cc';for(const[name,value]of Object.entries(docs))fs.writeFileSync(path.join(data,name),JSON.stringify(value));
const valid=()=>({name:'日常小事',description:'虚构书籍的日常练习',habits:Array.from({length:30},(_,i)=>'完成第'+(i+1)+'项练习')});
const book=new AdmZip();book.addFile('book.txt',Buffer.from('虚构读本：每天读一页，观察周围的自然，并记录一个小发现。'));const ordinaryZip=book.toBuffer();
let child,base,output='';const checks=[],cases=[];
async function launch(){const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:data,MEMO_CONFIG_DIR:work,PORT:String(port),CLAUDE_CLI:launcher,MEMO_EXTRA_RESPONSE:responseFile,MEMO_EXTRA_CALLS:path.join(work,'calls.log')},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let startup='';const timeout=setTimeout(()=>reject(new Error('startup timeout '+startup)),10000);child.stdout.on('data',d=>{output+=d;startup+=d;if(startup.includes('Memo server running')){clearTimeout(timeout);resolve();}});child.stderr.on('data',d=>{output+=d;startup+=d;});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('startup exit '+code+' '+startup));});});
}
async function pools(){return(await(await fetch(base+'/api/habit/pools')).json()).pools;}
async function upload(buffer=ordinaryZip,filename='fictional-book.zip'){const form=new FormData();form.append('zipFile',new Blob([buffer]),filename);const res=await fetch(base+'/api/habit/pools/generate',{method:'POST',body:form});return{httpStatus:res.status,body:await res.json()};}
async function removePool(pool){if(pool?.id)assert.equal((await fetch(base+'/api/habit/pools/'+pool.id,{method:'DELETE'})).status,200);}
async function main(){await launch();
  const variants=[
    ['重复30条',v=>v.habits=Array(30).fill('每天认真阅读')],
    ['只有29条',v=>v.habits=v.habits.slice(0,29)],
    ['多于30条',v=>v.habits.push('额外的第三十一条练习')],
    ['包含空白卡',v=>v.habits[0]=' \n '],
    ['卡片超过25字',v=>v.habits[0]='长'.repeat(26)],
    ['卡池名超过5字',v=>v.name='超过五字的卡池名称'],
    ['卡池名称为对象',v=>v.name={invalid:true}],
    ['卡池介绍为数组',v=>v.description=['invalid']],
    ['缺失名称和介绍',v=>{delete v.name;delete v.description;}],
    ['卡片包含非字符串',v=>v.habits[0]=42],
    ['卡片数组为空',v=>v.habits=[]]
  ];
  for(const[name,mutate]of variants){const response=valid();mutate(response);fs.writeFileSync(responseFile,JSON.stringify(response));const before=(await pools()).length,result=await upload(),after=(await pools()).length;
    const saved=result.body.pool;const passed=result.httpStatus>=400&&after===before;
    checks.push({id:'AI52',variant:name,status:passed?'passed':'failed',beforePoolCount:before,afterPoolCount:after,httpStatus:result.httpStatus,savedPool:saved||null,error:result.body.error||null,modelFixture:response});await removePool(saved);
  }
  const invalid=checks.filter(c=>c.id==='AI52');cases.push({id:'AI52',status:invalid.every(c=>c.status==='passed')?'passed':'failed',detail:'真实书籍上传链路，模拟CC输出11类不合格结果；'+invalid.filter(c=>c.status==='failed').map(c=>c.variant).join('、')+'仍被保存。',verificationMode:'controlled',testedAt:new Date().toISOString(),evidence:['test/final-acceptance-evidence/2026-11-25-run-01/db/extra-checks.json'],shared:true});
  // UTF-8 multipart original filename must round-trip independently from book text decoding.
  fs.writeFileSync(responseFile,JSON.stringify(valid()));const chinese='虚构读本.zip',fileResult=await upload(ordinaryZip,chinese);assert.equal(fileResult.httpStatus,200);
  const filenamePassed=fileResult.body.pool.sourceFile===chinese;
  checks.push({id:'ZUI05',status:filenamePassed?'passed':'failed',expectedSourceFile:chinese,actualSourceFile:fileResult.body.pool.sourceFile,bookTextEncoding:'UTF-8, source filename metadata checked independently'});await removePool(fileResult.body.pool);
  cases.push({id:'ZUI05',status:filenamePassed?'passed':'failed',detail:'中文multipart原文件名：期望“'+chinese+'”，实际保存“'+fileResult.body.pool.sourceFile+'”；属于上传元数据编码，不是书籍文本解码。',verificationMode:'controlled',testedAt:new Date().toISOString(),evidence:['test/final-acceptance-evidence/2026-11-25-run-01/db/extra-checks.json'],shared:true});
  // Deliberate traversal targets remain inside work even if confinement fails.
  const uploadDir=path.join(data,'habit_upload');fs.mkdirSync(uploadDir,{recursive:true});
  const sentinels=[path.join(uploadDir,'fixture.txt'),path.join(work,'escape.txt'),path.join(work,'absolute.txt')];for(const file of sentinels)fs.writeFileSync(file,'SENTINEL');
  const maliciousNames=['../fixture.txt','../../../escape.txt',path.join(work,'absolute.txt'),'..\\fixture-win.txt'];
  const malicious=new AdmZip();maliciousNames.forEach((_,i)=>malicious.addFile('safe-'+i+'.txt',Buffer.from('虚构文本：不得越过隔离解压目录。')));malicious.getEntries().forEach((entry,i)=>entry.entryName=maliciousNames[i]);const zip=malicious.toBuffer();
  assert.deepEqual(new AdmZip(zip).getEntries().map(e=>e.entryName).sort(),maliciousNames.slice().sort());const before=(await pools()).length,pathResult=await upload(zip,'traversal-fixture.zip');
  assert.ok(sentinels.every(file=>fs.readFileSync(file,'utf8')==='SENTINEL'));assert.ok(!fs.existsSync(path.join(uploadDir,'fixture-win.txt')));await removePool(pathResult.body.pool);
  const malformed=await upload(Buffer.from('not a zip'),'broken.zip');assert.ok(malformed.httpStatus>=400);assert.equal((await pools()).length,before);
  for(const file of sentinels)fs.rmSync(file);assert.deepEqual(fs.readdirSync(uploadDir),[]);
  checks.push({id:'ZUI04',status:'passed',rawEntryNames:maliciousNames,traversalUploadStatus:pathResult.httpStatus,behavior:'adm-zip sanitized entry names within extraction directory; no sentinel changed; all temporary extraction files removed',malformedZipStatus:malformed.httpStatus,outsideWriteObserved:false});
  cases.push({id:'ZUI04',status:'passed',detail:'合成../、../../../、临时目录绝对路径和Windows分隔符ZIP，检查安全tmp哨兵均未改写；路径被安全规范化在解压目录。损坏ZIP拒绝且无卡池保存，临时文件清理通过。',verificationMode:'controlled',testedAt:new Date().toISOString(),evidence:['test/final-acceptance-evidence/2026-11-25-run-01/db/extra-checks.json'],shared:true});
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  const testedAt=new Date().toISOString();fs.writeFileSync(path.join(evidence,'extra-server.log'),output);
  fs.writeFileSync(path.join(evidence,'extra-checks.json'),JSON.stringify({testedAt,scope:'Real isolated server/HTTP/multipart/ZIP/SQLite; CC CLI output simulated only; no real models',checks},null,2));
  fs.writeFileSync(path.join(evidence,'summary-extra.json'),JSON.stringify({cases,issues:cases.filter(c=>c.status==='failed').map(c=>({id:c.id,severity:'P2',detail:c.detail,evidence:c.evidence})),testedAt},null,2));
  console.log(JSON.stringify({cases,checks:checks.length},null,2));fs.rmSync(work,{recursive:true,force:true});
});
