// Real Codex/CodeBuddy wish and ZIP UI acceptance; fictional data only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const AdmZip=require('adm-zip');
const {getSelectableAgent,resolveCli}=require('../agents');
const agent=process.env.MEMO_TEST_AGENT || 'codex';
assert.ok(['codex','codebuddy'].includes(agent),'Real CLI only');
const info=getSelectableAgent(agent),root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-final-features-'+agent+'-'));
const out=path.resolve(process.env.MEMO_ACCEPTANCE_OUT);
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const report={agent,mode:'real-cli-ui',realCli:true,fakeModel:false,fictionalData:true,startedAt:new Date().toISOString(),checks:[],screenshots:[]};
let child,window,base,logs='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=code=>window.webContents.executeJavaScript(code);
const save=()=>fs.writeFileSync(path.join(out,'features-ui.json'),JSON.stringify(report,null,2)+'\n');
async function until(expression,timeout=300000){const end=Date.now()+timeout;while(Date.now()<end){if(await read(expression))return;await pause(60);}throw new Error('Timed out: '+expression);}
async function shot(name){await pause(150);fs.writeFileSync(path.join(out,name),(await window.webContents.capturePage()).toPNG());report.screenshots.push(name);save();}
async function step(ids,name,work){const row={ids,name,status:'running',startedAt:new Date().toISOString()};report.checks.push(row);save();try{row.details=await work();row.status='passed';}catch(error){row.status='failed';row.error=error.message;await shot(ids[0]+'-failed.png');}row.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(row));return row.status==='passed';}
async function pools(){const res=await fetch(base+'/api/habit/pools');assert.equal(res.status,200);return (await res.json()).pools;}
async function question(){await until(`document.querySelectorAll('.habit-wish-option').length===4 || !document.getElementById('habitWishError').classList.contains('hidden')`);assert.equal(await read(`document.getElementById('habitWishError').classList.contains('hidden')`),true,await read(`document.getElementById('habitWishError').textContent`));assert.equal(await read(`document.querySelectorAll('.habit-wish-option').length`),4);}
async function run(){
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MEMO_FAKE_'))delete env[key];
  const cli=resolveCli(agent,{env,configDir:path.resolve(__dirname,'..')});assert.ok(cli);report.cli=cli;
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);const fixture=require('../storage/defaults')();fixture['settings.json'].agent=agent;fixture['memos.json'].memos=[];fixture['habit_pools.json'].pools=[];fixture['scheduled_tasks.json']={tasks:[],pending:[]};
  for(const [name,value]of Object.entries(fixture))fs.writeFileSync(path.join(dataDir,name),JSON.stringify(value));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base=`http://127.0.0.1:${port}`;
  child=spawn(process.env.MEMO_TEST_NODE || process.execPath,[path.join(__dirname,'../server.js')],{env:{...env,ELECTRON_RUN_AS_NODE:'1',TZ:'Asia/Shanghai',MEMO_ELECTRON:'1',MEMO_CONFIG_DIR:root,MEMO_DATA_DIR:dataDir,[info.env]:cli,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup '+logs)),15000);child.stdout.on('data',data=>{logs+=data;if(logs.includes('Memo server running')){clearTimeout(timer);resolve();}});child.stderr.on('data',data=>{logs+=data;});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});});
  window=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>done({cancel:!details.url.startsWith(base+'/')}));
  await window.loadURL(base+'/');await until(`agentStatusKnown && aiState.configured && settings.agent===${JSON.stringify(agent)}`,15000);
  const wishOK=await step(['WUI01'],'真实愿望两轮选项与自由补充',async()=>{
    await read(`document.getElementById('btnHabitTrack').click();document.getElementById('habitWishStart').click();window.wishLengths=[];window.wishObserver=new MutationObserver(()=>{const text=document.querySelector('#habitWishMessages [data-current]')?.textContent || '';if(text.length && window.wishLengths.at(-1)!==text.length)window.wishLengths.push(text.length);});window.wishObserver.observe(document.getElementById('habitWishMessages'),{childList:true,subtree:true,characterData:true});document.getElementById('habitWishInput').value='我想开始画画';document.getElementById('habitWishForm').requestSubmit();`);
    await question();const first=await read(`({question:document.querySelector('#habitWishMessages [data-current]').textContent,options:[...document.querySelectorAll('.habit-wish-option')].map(el=>el.textContent),growths:window.wishLengths})`);await shot('wish-purpose.png');
    await read(`document.querySelectorAll('.habit-wish-option')[3].click();document.getElementById('habitWishInput').value='想和朋友一起享受画画的乐趣';document.getElementById('habitWishForm').requestSubmit();`);await question();
    assert.match(await read(`document.getElementById('habitWishStep').textContent`),/3 \/ 3/);const second=await read(`({question:document.querySelector('#habitWishMessages [data-current]').textContent,options:[...document.querySelectorAll('.habit-wish-option')].map(el=>el.textContent)})`);await shot('wish-effort.png');return {first,second,fileInputOnlySynthetic:true};
  });
  if(wishOK){
    await step(['WUI02'],'愿望收起恢复及切换弹窗保留',async()=>{const before=await read(`document.getElementById('habitWishMessages').textContent`);await read(`document.getElementById('habitWishHide').click();document.getElementById('habitWishStart').click();document.getElementById('tagSummaryClose').click();document.getElementById('btnHabitTrack').click();`);assert.equal(await read(`document.getElementById('habitWishMessages').textContent`),before);return {preserved:true};});
    await step(['WUI-GENERATE'],'真实愿望生成保存及详情',async()=>{
      await read(`document.querySelectorAll('.habit-wish-option')[3].click();document.getElementById('habitWishInput').value='每天五分钟，用手边纸笔轻松尝试，不买设备';document.getElementById('habitWishForm').requestSubmit();`);
      await until(`!document.getElementById('habitWishSuccess').classList.contains('hidden') || !document.getElementById('habitWishError').classList.contains('hidden')`);assert.equal(await read(`document.getElementById('habitWishError').classList.contains('hidden')`),true,await read(`document.getElementById('habitWishError').textContent`));
      const saved=await pools();assert.equal(saved.length,1);assert.equal(saved[0].habits.length,30);assert.equal(saved[0].wishContext.purpose,'想和朋友一起享受画画的乐趣');await read(`document.getElementById('habitWishView').click()`);assert.equal(await read(`document.querySelectorAll('.habit-pool-detail-item').length`),30);await shot('wish-pool-detail.png');await read(`document.getElementById('habitPoolDetailClose').click();document.getElementById('habitWishRestart').click()`);assert.equal(await read(`document.getElementById('habitWishInput').value`),'');return {pool:saved[0],restartCleared:true};
    });
  }
  const zip=new AdmZip();zip.addFile('虚构读本.txt',Buffer.from('《小步生活》为虚构验收读本。每天观察光线、整理桌面、照顾绿植、阅读一页、记录感受、散步、伸展、倾听、感谢、准备明天。用不同场景形成多样的微小习惯。'));
  const bytes=zip.toBuffer().toString('base64');let modes=[];
  for(const mode of ['choose','drop']){
    await step([mode==='choose'?'ZUI03':'ZUI01'],'真实书籍上传 '+mode,async()=>{
      await read(`document.getElementById('habitWishHide').click()`);const before=(await pools()).length;
      await read(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],'虚构读本.zip',{type:'application/zip'}));${mode==='choose'?"const input=document.getElementById('habitFileInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));":"const area=document.getElementById('habitUploadArea');area.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));if(!area.classList.contains('dragover'))throw new Error('Missing drag highlight');area.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));"}})()`);
      assert.equal(await read('habitGenerating'),false,'Selecting a source must wait for explicit generation');
      await read(`document.getElementById('habitMaterialSubmit').click()`);
      await until(`!document.getElementById('habitUploadProgress').classList.contains('hidden')`,15000);await shot('book-'+mode+'-progress.png');
      await until(`habitPools.length>${before} || (!habitGenerating && document.getElementById('habitUploadProgress').classList.contains('hidden'))`);
      const saved=await pools();assert.equal(saved.length,before+1,await read(`document.getElementById('appToast').textContent`));assert.equal(saved.at(-1).habits.length,30);await read(`document.querySelectorAll('.habit-pool-info')[${before}].click()`);assert.equal(await read(`document.querySelectorAll('.habit-pool-detail-item').length`),30);await shot('book-'+mode+'-detail.png');await read(`document.getElementById('habitPoolDetailClose').click()`);
      let remaining=[];for(let i=0;i<30;i++){remaining=fs.readdirSync(path.join(dataDir,'habit_upload'));if(!remaining.length)break;await pause(50);}assert.deepEqual(remaining,[]);modes.push(mode);return {cards:30,pool:saved.at(-1),fileSelectionEventInjected:true,model:'real',uploadCleaned:true,modes:[...modes]};
    });
  }
}
app.whenReady().then(run).catch(error=>{report.fatalError=error.stack;process.exitCode=1;console.error(error.stack);}).finally(async()=>{if(window&&!window.isDestroyed())window.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}report.finishedAt=new Date().toISOString();report.success=!report.fatalError&&report.checks.every(row=>row.status==='passed');save();fs.writeFileSync(path.join(out,'features-server.log'),logs);fs.rmSync(root,{recursive:true,force:true});app.exit(report.success?0:1);});
