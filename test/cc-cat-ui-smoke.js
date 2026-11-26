// Run with Electron and MEMO_TEST_NODE pointing at a Node.js executable.
// All operations use a fresh database and the deterministic local model fixture.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cat-ui-'));
const evidenceDir = path.join(os.tmpdir(),'memo-cat-ui-evidence-'+Date.now()+'-'+process.pid);
const reportPath = process.env.MEMO_CAT_UI_REPORT || path.join(evidenceDir,'report.json');
const screenshotPath = process.env.MEMO_CAT_UI_SCREENSHOT || path.join(evidenceDir,'frontend.png');
const report = { checks:[], transitions:[], rendererErrors:[], serverLog:'' };
app.setPath('userData', path.join(root,'profile'));app.disableHardwareAcceleration();
// Keep Electron alive until the fixture server and temporary profile are removed.
app.on('window-all-closed',()=>{});
let child, window;
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const js = expression => window.webContents.executeJavaScript(expression);
async function until(expression, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await js(expression)) return;
    await delay(20);
  }
  const details = await js(`({model:window._ccActivity?.snapshot(),scene:window.CCPixelCat?.mount(document.getElementById('ccScene'))?.state,history:window.__catSmoke?.states.slice(-15)})`);
  throw new Error('UI wait failed: '+expression+'\n'+JSON.stringify(details));
}
async function expectState(state, timeout) {
  await until(`window._ccActivity.getState()===${JSON.stringify(state)} && CCPixelCat.mount(document.getElementById('ccScene')).state===${JSON.stringify(state)}`,timeout);
}
function passed(name, details = {}) { report.checks.push({ name, ...details });console.log('PASS '+name); }
async function installRecorder() {
  await js(`
    window.__catSmoke={states:[],events:[]};
    window.addEventListener('cc-task-update',event=>{
      __catSmoke.events.push({at:Date.now(),status:event.detail.task?.status || null,stage:event.detail.task?.stage || null,model:_ccActivity.getState(),scene:CCPixelCat.mount(document.getElementById('ccScene')).state});
    });
    setInterval(()=>{
      const scene=CCPixelCat.mount(document.getElementById('ccScene')).state;
      const next={at:Date.now(),model:_ccActivity.getState(),scene,busy:_ccActivity.isBusy()};
      const last=__catSmoke.states.at(-1);
      if(!last || last.model!==next.model || last.scene!==next.scene || last.busy!==next.busy)__catSmoke.states.push(next);
    },10);
  `);
}
async function collectTransitions(label) {
  report.transitions.push({label,...await js('({states:__catSmoke.states,events:__catSmoke.events})')});
}
async function clickDaily() { await js(`document.getElementById('digestRegenBtn').click()`); }
async function checkCatLayout(expectedScale) {
  // Wait for the bubble's pop animation and its requestAnimationFrame positioning.
  await delay(300);
  const layout=await js(`(()=>{
    const rect=element=>{const {left,right,top,bottom,width,height}=element.getBoundingClientRect();return {left,right,top,bottom,width,height};};
    const bubble=document.getElementById('ccTaskBubble');
    const cat=document.getElementById('ccScene'),strip=document.querySelector('.cc-walk-strip');
    const bubbleStyle=getComputedStyle(bubble),catStyle=getComputedStyle(cat),lineStyle=getComputedStyle(strip,'::before');
    const canvas=cat.querySelector('canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let lastPixel=0;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3])lastPixel=Math.max(lastPixel,y);
    const canvasRect=canvas.getBoundingClientRect();
    const originalFlip=cat.classList.contains('flip');
    cat.classList.remove('flip');const normalScale=getComputedStyle(cat).scale;
    cat.classList.add('flip');const flipScale=getComputedStyle(cat).scale;
    cat.classList.toggle('flip',originalFlip);
    return {bubble:rect(bubble),cat:rect(cat),strip:rect(strip),searchTop:document.querySelector('.search-bar').getBoundingClientRect().top,footBottom:canvasRect.top+(lastPixel+1)/canvas.height*canvasRect.height,bubbleOffsetWidth:bubble.offsetWidth,bubbleLeft:parseFloat(bubble.style.left),visible:!bubble.classList.contains('hidden'),
      style:{stripHeight:getComputedStyle(strip).height,lineTop:lineStyle.top,lineHeight:lineStyle.height,bottom:bubbleStyle.bottom,whiteSpace:bubbleStyle.whiteSpace,maxWidth:bubbleStyle.maxWidth,borderWidth:bubbleStyle.borderTopWidth,borderRadii:[bubbleStyle.borderTopLeftRadius,bubbleStyle.borderTopRightRadius,bubbleStyle.borderBottomRightRadius,bubbleStyle.borderBottomLeftRadius],padding:bubbleStyle.padding,catBottom:catStyle.bottom,normalScale,flipScale,spanLineClamp:getComputedStyle(bubble.querySelector('span')).webkitLineClamp},canvasCount:cat.querySelectorAll('canvas').length};
  })()`);
  assert.equal(layout.visible,true,'layout check requires a visible task bubble');
  assert.deepEqual({lineTop:layout.style.lineTop,lineHeight:layout.style.lineHeight},
    {lineTop:'0px',lineHeight:'8px'},'the original decorative line remains');
  assert.equal(parseFloat(layout.style.stripHeight),8,'the cat must not introduce an extra row above search');
  assert.deepEqual({bottom:layout.style.bottom,whiteSpace:layout.style.whiteSpace,maxWidth:layout.style.maxWidth,borderWidth:layout.style.borderWidth,borderRadii:layout.style.borderRadii,padding:layout.style.padding},
    {bottom:'14px',whiteSpace:'nowrap',maxWidth:'280px',borderWidth:'2px',borderRadii:['18px','18px','4px','18px'],padding:'8px 13px'},'the original CC bubble styling remains');
  assert.notEqual(layout.style.spanLineClamp,'2','the bubble must not receive a new two-line clamp');
  const expectedLeft=Math.max(4,layout.cat.left-layout.strip.left-layout.bubbleOffsetWidth-10);
  assert.ok(Math.abs(layout.bubbleLeft-expectedLeft)<0.05,'bubble follows the original position formula: '+JSON.stringify(layout));
  assert.equal(layout.style.catBottom,'-4px');
  assert.ok(Math.abs(layout.footBottom-layout.searchTop)<0.75,'the actual visible paws sit on the search panel: '+JSON.stringify(layout));
  assert.equal(Number(layout.style.normalScale),expectedScale);
  assert.deepEqual(layout.style.flipScale.split(' ').map(Number),[-expectedScale,expectedScale]);
  assert.equal(layout.canvasCount,1,'the new sprite occupies the existing CC scene');
  return layout;
}

async function compactGeometry() {
  return js(`(()=>{
    const cat=document.getElementById('ccScene'),strip=cat.parentElement;
    const c=cat.getBoundingClientRect(),s=strip.getBoundingClientRect(),line=getComputedStyle(strip,'::before');
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const controls=[...document.querySelectorAll('.filter-bar .filter-label,.filter-bar .filter-tag,.filter-bar .filter-expand,#clearFilterBtn')].filter(e=>e.getClientRects().length);
    const collisions=controls.filter(e=>{const r=e.getBoundingClientRect();return Math.min(c.right,r.right)-Math.max(c.left,r.left)>.1 && Math.min(c.bottom,r.bottom)-Math.max(c.top,r.top)>.1;}).map(e=>({text:e.textContent,rect:rect(e)}));
    return {plan:_ccCtrl.getIdlePlan(),height:s.height,minHeight:strip.style.minHeight,extraRow:strip.classList.contains('cat-needs-row'),cat:rect(cat),
      left:s.left+(parseFloat(line.left)||0)+(parseFloat(line.width)||0)+8,right:s.right-8,collisions};
  })()`);
}
function assertCompactGeometry(geometry) {
  assert.ok(Math.abs(geometry.height-8)<.1,'the strip remains compact at eight pixels: '+JSON.stringify(geometry));
  assert.equal(geometry.minHeight,'','no inline minimum height creates a cat-only row');
  assert.equal(geometry.extraRow,false);
  assert.deepEqual(geometry.collisions,[],'the complete cat hitbox does not cover filter controls');
  assert.ok(geometry.cat.left>=geometry.left-.1 && geometry.cat.right<=geometry.right+.1,'the complete body and tail remain inside the original right-side region');
  assert.equal(geometry.plan.bounds.canRoam,true,'the reserved horizontal lane permits the original idle walk');
}

async function run() {
  const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  const data=require('../storage/defaults')();
  for (const [file,value] of Object.entries(data)) fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const node=process.env.MEMO_TEST_NODE || process.execPath;
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  const fake=path.join(root,'fake-claude'),mode=path.join(root,'mode'),capture=path.join(root,'calls.jsonl');
  const writeWrapper = pause => fs.writeFileSync(fake,`#!/bin/sh\n${pause ? `if [ "$1" != "--version" ]; then sleep ${pause}; fi\n` : ''}exec ${quote(node)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
  writeWrapper(0);fs.writeFileSync(mode,'stream-slow');
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  child=spawn(node,[path.join(__dirname,'../server.js')],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MEMO_ELECTRON:'1',MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,PORT:String(port),CLAUDE_CLI:fake,MEMO_FAKE_CC_INVALID_FILE:mode,MEMO_FAKE_CC_CAPTURE:capture},
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data',chunk=>{report.serverLog+=chunk;});
  child.stderr.on('data',chunk=>{report.serverLog+=chunk;});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(report.serverLog)),10000);
    child.stdout.on('data',()=>{if(report.serverLog.includes('Memo server running')){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Startup '+code+': '+report.serverLog));});
  });
  window=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)report.rendererErrors.push(message);});
  window.webContents.session.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>callback({cancel:!details.url.startsWith(`http://127.0.0.1:${port}/`)}));
  await window.loadURL(`http://127.0.0.1:${port}`);
  await until(`agentStatusKnown && aiState.configured && document.querySelector('#ccScene canvas') && _ccCtrl.getPos()>0`);
  await installRecorder();await expectState('idle');
  assert.deepEqual(await js(`(()=>{const c=CCPixelCat.mount(document.getElementById('ccScene'));return [c.canvas.width,c.canvas.height,document.querySelectorAll('#ccScene canvas').length]})()`),[58,44,1]);
  passed('main scene mounts the approved single-canvas sprite');

  await clickDaily();await expectState('thinking');await expectState('coding');
  await js(`document.getElementById('ccScene').click()`);
  await until(`!document.getElementById('aiTaskModal').classList.contains('hidden')`);
  assert.equal(await js('_ccActivity.getState()'),'coding','clicking a working cat must not replace the task animation');
  await js(`document.getElementById('aiTaskClose').click()`);
  await expectState('happy');
  await delay(20);
  const firstRun=await js(`(()=>{
    const timeline=[...__catSmoke.states,...__catSmoke.events].sort((a,b)=>a.at-b.at);
    const coding=timeline.find(item=>item.model==='coding');
    const happy=timeline.find(item=>item.model==='happy' && item.at>=coding?.at);
    return {coding,happy,backwards:timeline.filter(item=>item.at>=coding?.at && item.at<=happy?.at && item.model==='thinking')};
  })()`);
  assert.ok(firstRun.coding && firstRun.happy,'the first task must visibly work and then complete');
  assert.deepEqual(firstRun.backwards,[],'terminal task updates must not expose the pending HTTP waiting placeholder');
  passed('work transitions directly to success without flashing back to thinking');
  assert.equal(await js(`getComputedStyle(document.querySelector('#ccScene .cat-symbol-happy')).display`),'block');
  const desktopBubble=await checkCatLayout(0.5);
  fs.mkdirSync(path.dirname(screenshotPath),{recursive:true});
  fs.writeFileSync(screenshotPath,(await window.webContents.capturePage()).toPNG());
  passed('real daily-summary click and SSE produce thinking, coding, then happy');
  passed('busy click opens task details without interrupting work');

  // Delay only the fake CLI, ensuring the old success timer expires during new work.
  writeWrapper(1);fs.writeFileSync(mode,'slow');
  const marker=await js('Date.now()');
  await clickDaily();await expectState('thinking');
  await delay(3000);
  assert.equal(await js('_ccActivity.isBusy()'),true);
  assert.equal(await js('_ccActivity.getState()'),'thinking');
  assert.equal(await js(`__catSmoke.states.some(s=>s.at>=${marker} && (s.model==='idle' || s.scene==='walk'))`),false);
  await expectState('happy');writeWrapper(0);
  passed('new work cancels the prior completion timer and pauses idle walking');
  await collectTransitions('daily-success-and-consecutive-task');

  await window.webContents.reload();
  await until(`agentStatusKnown && aiState.configured && window._ccLatestTask?.status==='completed' && document.querySelector('#ccScene canvas')`);
  await installRecorder();await expectState('idle');await delay(350);
  assert.equal(await js(`__catSmoke.states.some(s=>s.model==='happy')`),false);
  passed('reloading a retained completed task does not replay celebration');

  fs.writeFileSync(mode,'fail:daily-digest');
  await clickDaily();await expectState('thinking');await expectState('error');
  assert.equal(await js(`getComputedStyle(document.querySelector('#ccScene .cat-symbol-error')).display`),'block');
  assert.equal(await js(`_ccLatestTask.status`),'failed');
  await expectState('idle');
  passed('a real failed task shows the pixel question mark then returns idle');

  const searchStart=await js(`
    document.getElementById('searchInput').value='欢迎';
    document.getElementById('searchInput').dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('searchInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    Date.now();
  `);
  await expectState('looking');
  assert.equal(await js(`getComputedStyle(document.querySelector('#ccScene .cat-symbol-looking')).display`),'block');
  await delay(250);assert.equal(await js('_ccActivity.getState()'),'looking');
  await expectState('idle');
  const searchDuration=await js(`Date.now()-${searchStart}`);assert.ok(searchDuration>=550);
  await js(`document.getElementById('searchClearBtn').click()`);
  passed('local search shows a visible magnifier for the minimum duration',{durationMs:searchDuration});

  await js(`document.getElementById('tagManagerBtn').click();document.getElementById('newTagName').value='像素猫测试';document.getElementById('addNewTagBtn').click()`);
  await expectState('sweeping');await expectState('happy');
  assert.equal(await js(`allTags.includes('像素猫测试')`),true);
  await js(`document.getElementById('tagManagerClose').click()`);
  await expectState('idle');
  passed('tag management drives organizing and success through actual UI handlers');

  fs.writeFileSync(mode,'stream-slow');
  await js(`document.getElementById('btnTagSuggest').click()`);
  await until(`!document.getElementById('tagSuggestModal').classList.contains('hidden')`);
  await js(`document.getElementById('tagSuggestGenBtn').click()`);
  await expectState('thinking');await expectState('sweeping');await expectState('happy');
  await js(`document.getElementById('tagSuggestClose').click()`);
  await expectState('idle');
  passed('AI tag organizing is selected by real task metadata');

  window.setContentSize(390,820);await delay(180);
  const narrow=await js(`(()=>{const c=document.getElementById('ccScene').getBoundingClientRect(),s=document.querySelector('.cc-walk-strip').getBoundingClientRect();return {catLeft:c.left,catRight:c.right,stripLeft:s.left,stripRight:s.right,viewport:innerWidth};})()`);
  assert.ok(Math.abs(narrow.catRight-narrow.catLeft-60)<0.05,'the mobile scene uses the larger 0.4 scale');
  assert.ok(narrow.catLeft>=narrow.stripLeft && narrow.catRight<=narrow.stripRight,'the larger mobile scene remains inside its strip');
  passed('390px viewport enlarges the cat without leaving the strip',narrow);
  await clickDaily();await expectState('thinking');await expectState('coding');await expectState('happy');
  const mobileBubble=await checkCatLayout(0.4);
  passed('desktop and mobile paws touch the panel and task bubbles retain their style and position',{desktop:desktopBubble,mobile:mobileBubble});
  const mobileScreenshot=path.join(path.dirname(screenshotPath),path.parse(screenshotPath).name+'-mobile.png');
  fs.writeFileSync(mobileScreenshot,(await window.webContents.capturePage()).toPNG());
  report.mobileScreenshot=mobileScreenshot;
  await expectState('idle');

  const filterLayouts=[];
  for(const width of [390,1100]) {
    window.setContentSize(width,width===390?820:900);await delay(200);
    for(const state of [{selected:false,expanded:false},{selected:true,expanded:false},{selected:true,expanded:true},{selected:false,expanded:true}]) {
      await js(`(()=>{
        if(${state.selected}) {
          if(filterAllSelected)document.querySelector('#filterTags .filter-tag:not([data-tag="__all__"])').click();
        } else if(!filterAllSelected)document.querySelector('#filterTags [data-tag="__all__"]').click();
        if(filterExpanded!==${state.expanded})document.querySelector('#filterTags .filter-expand').click();
      })()`);
      await delay(250);
      const geometry=await compactGeometry();assertCompactGeometry(geometry);
      filterLayouts.push({width,...state,...geometry});
    }
  }
  passed('all and selected tags retain a compact safe walking lane when collapsed or expanded at both widths',{filterLayouts});

  window.setContentSize(1100,900);await delay(200);
  await js(`if(filterExpanded)document.querySelector('#filterTags .filter-expand').click()`);await delay(200);
  await until(`_ccCtrl.getIdlePlan().active && _ccCtrl.getIdlePlan().bounds.canRoam`);
  const idleMarker=await js('Date.now()');let idleEpoch=await js('_ccCtrl.getIdlePlan().epoch');
  // Normal polling re-renders the tags. Identical geometry must not restart the
  // initial rest, otherwise a seemingly valid schedule can never start moving.
  for(let i=0;i<3;i++) { await delay(1000);await js('renderFilterTags()'); }
  assert.equal(await js('_ccCtrl.getIdlePlan().epoch'),idleEpoch,'same-size tag refreshes preserve continuous idle time');
  // Electron's offscreen fixture does not expose native tab visibility. Drive
  // the browser event explicitly, while retaining the real scheduler clock.
  const waiting=await js(`(()=>{window.__catHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__catHidden});document.dispatchEvent(new Event('visibilitychange'));return {at:performance.now(),plan:_ccCtrl.getIdlePlan()};})()`);
  assert.equal(waiting.plan.active,false);assert.equal(waiting.plan.suspended,true);
  await delay(1500);
  const waitingResumed=await js(`(()=>{window.__catHidden=false;document.dispatchEvent(new Event('visibilitychange'));return {at:performance.now(),plan:_ccCtrl.getIdlePlan()};})()`);
  assert.equal(waitingResumed.plan.active,true);assert.equal(waitingResumed.plan.suspended,false);
  assert.equal(waitingResumed.plan.position,waiting.plan.position);
  assert.ok(Math.abs((waitingResumed.at-waitingResumed.plan.segmentAt)-(waiting.at-waiting.plan.segmentAt))<100,'returning to the page retains the rest already elapsed');
  assert.ok(waitingResumed.plan.epoch-idleEpoch>=1450,'only time spent hidden is excluded from idle timing');
  idleEpoch=waitingResumed.plan.epoch;
  passed('page visibility preserves the elapsed five-second initial wait',{waiting,waitingResumed});
  await until(`CCPixelCat.mount(document.getElementById('ccScene')).state==='walk'`,6500);
  const first=await js(`({at:performance.now(),plan:_ccCtrl.getIdlePlan(),left:document.getElementById('ccScene').getBoundingClientRect().left})`);
  assert.ok(first.at-idleEpoch>=5000 && first.at-idleEpoch<5500,'the real first walk starts at five seconds');
  await delay(900);
  const later=await js(`({plan:_ccCtrl.getIdlePlan(),left:document.getElementById('ccScene').getBoundingClientRect().left})`);
  assert.ok(Math.abs(later.left-first.left)>1,'the resumed slow walk makes visible continuous progress');
  assert.equal(Math.sign(later.left-first.left),first.plan.direction,'the resumed walk follows its selected route direction');
  const safety=await compactGeometry();assertCompactGeometry(safety);
  assert.equal(await js(`__catSmoke.states.some(s=>s.at>=${idleMarker} && !['idle','walk'].includes(s.scene))`),false);
  passed('real idle time waits five seconds then starts a bounded eight-second slow walk',{first,later,safety});

  const walkingPaused=await js(`(()=>{window.__catHidden=true;document.dispatchEvent(new Event('visibilitychange'));return _ccCtrl.getIdlePlan();})()`);
  assert.equal(walkingPaused.active,false);assert.equal(walkingPaused.suspended,true);
  await delay(1200);
  assert.equal(await js('_ccCtrl.getPos()'),walkingPaused.position,'a hidden page freezes the exact walking position');
  const walkingResumed=await js(`(()=>{window.__catHidden=false;document.dispatchEvent(new Event('visibilitychange'));return _ccCtrl.getIdlePlan();})()`);
  assert.equal(walkingResumed.phase,'walk','returning during a walk continues immediately');
  assert.ok(Math.abs(walkingResumed.position-walkingPaused.position)<.1,'returning never teleports the cat');
  await delay(700);
  assert.ok(Math.abs(await js('_ccCtrl.getPos()')-walkingResumed.position)>1,'the continued walk advances without another rest');
  await js(`delete document.hidden;delete window.__catHidden;document.dispatchEvent(new Event('visibilitychange'))`);
  passed('page visibility freezes and continues an existing slow walk',{walkingPaused,walkingResumed});

  await clickDaily();await expectState('thinking');
  const frozen=await js('_ccCtrl.getPos()');assert.equal(await js('_ccCtrl.getIdlePlan().active'),false);
  await expectState('coding');assert.equal(await js('_ccCtrl.getPos()'),frozen);
  await expectState('happy');assert.equal(await js('_ccCtrl.getPos()'),frozen);
  await expectState('idle');assert.equal(await js('_ccCtrl.getPos()'),frozen);
  const resumedEpoch=await js('_ccCtrl.getIdlePlan().epoch');await delay(3200);
  assert.equal(await js('_ccCtrl.getPos()'),frozen);assert.equal(await js('_ccCtrl.getIdlePlan().epoch'),resumedEpoch);
  passed('a real task pauses the slow walk immediately and restarts idle timing after existing feedback',{frozen,resumedEpoch});

  // Offscreen windows have document.hasFocus()===false even after Tab.
  // Emulate a focused page so Chromium can expose its real :focus-visible state.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await js(`_ccCtrl.stop()`);
  const catBounds=await js(`(()=>{const r=document.getElementById('ccScene').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  window.webContents.sendInputEvent({type:'mouseDown',x:Math.round(catBounds.x),y:Math.round(catBounds.y),button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseUp',x:Math.round(catBounds.x),y:Math.round(catBounds.y),button:'left',clickCount:1});
  await expectState('happy');
  assert.equal(await js(`getComputedStyle(document.getElementById('ccScene')).outlineStyle`),'none','pointer click never draws a rectangular outline');
  await expectState('idle');
  await js(`document.getElementById('searchInput').focus()`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});
  await until(`document.activeElement===document.getElementById('ccScene')`);
  assert.equal(await js(`document.getElementById('ccScene').matches(':focus-visible')`),true);
  assert.notEqual(await js(`getComputedStyle(document.querySelector('#ccScene .cc-cat-art')).filter`),'none','keyboard navigation highlights the sprite silhouette');
  assert.equal(await js(`getComputedStyle(document.getElementById('ccScene')).outlineStyle`),'none');
  passed('mouse interaction has no box and keyboard focus highlights the cat silhouette');
  await js(`_ccCtrl.resume()`);

  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  await delay(3700);
  assert.equal(await js(`CCPixelCat.mount(document.getElementById('ccScene')).state`),'idle');
  passed('reduced-motion preference disables idle roaming');
  window.webContents.debugger.detach();
  await collectTransitions('reload-failure-search-organizing-and-layout');
  report.fakeModelCalls=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse).map(call=>call.task);
  report.ok=true;report.screenshot=screenshotPath;
}

app.whenReady().then(run).catch(error=>{
  report.ok=false;report.error=error.stack;console.error(error.stack);process.exitCode=1;
}).finally(async()=>{
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  window?.destroy();
  if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  fs.rmSync(root,{recursive:true,force:true});
  console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,report:reportPath,screenshot:report.screenshot}));
  app.exit(process.exitCode || 0);
});
