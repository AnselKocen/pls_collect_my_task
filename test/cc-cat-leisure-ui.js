// Main-page Chromium regression with synthetic API responses and a virtual clock.
// Run: MEMO_PLAYWRIGHT=/path/to/playwright node test/cc-cat-leisure-ui.js
// MEMO_CHROME overrides the browser executable; no server or model CLI is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.MEMO_PLAYWRIGHT || 'playwright');

const publicDir = path.join(__dirname, '../public');
const origin = 'http://memo-cat-leisure.test';
const evidence = process.env.MEMO_CAT_LEISURE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cat-leisure-ui-'));
const settings = { ...require('../storage/defaults')()['settings.json'], theme:'mintchoc', tags:['mark','待办','脑洞','链接','账号','备份','思考'], tagOrder:['mark','待办','脑洞','链接','账号','备份','思考'] };
const date = new Date('2026-11-27T02:00:00Z').toISOString();
const memos = settings.tags.flatMap(tag => Array.from({ length:3 }, (_, i) => ({ id:tag+'-'+i, content:tag+'：合成记录 '+i, tags:[tag], createdAt:date, updatedAt:date })));
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const report = { checks:[], errors:[], unexpectedRequests:[], fixture:'in-memory APIs, production main page and scheduler, virtual browser clock, no model calls' };
let browser, currentPage;

function passed(name, details = {}) {
  report.checks.push({ name, ...details });
  console.log('PASS '+name);
}

// This response-only wrapper controls the existing scheduler's random source.
// It also records the pool after the production time/space eligibility checks.
// No test hooks are added to the application source or written to the server.
const schedulerHarness = `
;(() => {
  const originalCreate = CCPixelCatIdle.create;
  window.__catLeisure = { pick:'yarn', candidates:[], candidateAt:null, draws:[], updates:[] };
  CCPixelCatIdle.create = options => originalCreate({
    ...options,
    canPlayAction(action, plan) {
      const h = window.__catLeisure, at = performance.now();
      if (h.candidateAt !== at) { h.candidateAt = at; h.candidates = []; }
      const allowed = !options.canPlayAction || options.canPlayAction(action, plan);
      if (allowed) h.candidates.push(action.name);
      return allowed;
    },
    random() {
      const h = window.__catLeisure, candidates = h.candidates;
      const requested = candidates.indexOf(h.pick), index = Math.max(0, requested);
      h.draws.push({ at:performance.now(), requested:h.pick, candidates:[...candidates], selected:candidates[index] });
      return (index + .25) / candidates.length;
    },
    onUpdate(plan) {
      options.onUpdate(plan);
      const h = window.__catLeisure;
      const state = CCPixelCat.mount(document.getElementById('ccScene')).state;
      const signature = [plan.phase,plan.action?.name,plan.action?.startedAt,state].join(':');
      if (signature !== h.last) {
        h.updates.push({ at:performance.now(), elapsed:plan.elapsed, position:plan.position, phase:plan.phase, action:plan.action, state, activity:_ccActivity.getState() });
        h.last = signature;
      }
    }
  });
})();
`;

async function installRoutes(context) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.fulfill({ status:200, contentType:'application/javascript', body:'' });
    const json = body => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        report.unexpectedRequests.push({ method:request.method(), path:url.pathname });
        return route.fulfill({ status:400, contentType:'application/json', body:'{"error":"No task API calls are permitted in this fixture"}' });
      }
      if (url.pathname === '/api/settings') return json(settings);
      if (url.pathname === '/api/tags') return json(settings.tags);
      if (url.pathname === '/api/memos') return json(memos);
      if (url.pathname === '/api/ai/status') return json({ agent:'cc', name:'Synthetic local agent', configured:true, busy:false, maintenance:false, task:'', elapsedMs:0 });
      if (url.pathname === '/api/ai/task') return json({ streamId:'cat-leisure-test', revision:0, task:null });
      if (url.pathname === '/api/ai/events') return route.fulfill({ status:204, contentType:'text/event-stream', body:'' });
      if (url.pathname === '/api/cc/suggestions') return json({ dailyDigest:{ date:date.slice(0,10), summary:'合成摘要：记录日常的小发现。' }, weeklyDigests:[], tagSuggestions:[], graphHistory:[] });
      if (url.pathname === '/api/scheduled/pending') return json({ pending:[] });
      report.unexpectedRequests.push({ method:request.method(), path:url.pathname });
      return json({});
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status:204, body:'' });
    const file = path.resolve(publicDir, '.'+(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status:404, body:'Not found' });
    let body = fs.readFileSync(file);
    if (url.pathname === '/cc-cat-idle.js') body = body.toString()+schedulerHarness;
    return route.fulfill({ status:200, contentType:mime[path.extname(file)] || 'application/octet-stream', body });
  });
}

async function openPage(width = 1100, pick = 'yarn') {
  const context = await browser.newContext({ viewport:{ width, height:900 }, deviceScaleFactor:1 });
  await installRoutes(context);
  const page = await context.newPage();currentPage = page;
  page.on('pageerror', error => report.errors.push({ width, message:error.message }));
  await page.clock.install({ time:new Date(date) });
  await page.goto(origin, { waitUntil:'load' });
  await page.waitForFunction(() => typeof window._ccCtrl?.getIdlePlan === 'function' && window._ccActivity.getState() === 'idle' && document.getElementById('digestText').textContent.includes('合成摘要'));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.clock.pauseAt(await page.evaluate(() => Date.now()+100));
  await restart(page, pick);
  return { page, context };
}

async function restart(page, pick) {
  return page.evaluate(pick => {
    __catLeisure.pick = pick;__catLeisure.draws = [];__catLeisure.updates = [];__catLeisure.last = null;
    _ccCtrl.stop();_ccCtrl.resume();
    return _ccCtrl.getIdlePlan();
  }, pick);
}

async function state(page) {
  return page.evaluate(() => {
    const cat = document.getElementById('ccScene'), record = CCPixelCat.mount(cat);
    return { now:performance.now(), plan:_ccCtrl.getIdlePlan(), scene:record.state, startedAt:record.startedAt, progress:CCPixelCat.getProgress(cat), activity:_ccActivity.getState(), busy:_ccActivity.isBusy(), flip:cat.classList.contains('flip'), draws:__catLeisure.draws };
  });
}

async function advanceWall(page, duration) {
  // Preserve timer delivery across each meaningful boundary without rendering
  // every intermediate browser frame during the long endpoint checks.
  if (duration > 100) await page.clock.fastForward(duration-100);
  if (duration > 0) await page.clock.runFor(Math.min(duration,100));
}

async function advanceTo(page, elapsed) {
  for (let iterations=0;iterations<1000;iterations++) {
    const current=await state(page), remaining=elapsed-current.plan.elapsed;
    assert.ok(remaining >= -.1, 'effective idle time must advance monotonically: '+remaining);
    if (remaining <= .1) return current;
    if (current.plan.action) {
      await advanceWall(page,Math.max(50,current.plan.action.startedAt+current.plan.action.duration-current.now));
    } else {
      const nextLight=3000-current.plan.elapsed%3000, nextLeisure=10000-current.plan.elapsed%10000;
      await advanceWall(page,Math.min(remaining,nextLight,nextLeisure));
    }
  }
  throw new Error('effective idle clock failed to make progress: '+JSON.stringify(await state(page)));
}

function assertFullAction(current, name, expectedState) {
  assert.equal(current.activity, 'idle', 'leisure must not invent an activity');
  assert.equal(current.busy, false);
  assert.equal(current.plan.action?.name, name, JSON.stringify(current));
  assert.equal(current.plan.action?.state, expectedState);
  assert.equal(current.scene, expectedState);
  assert.ok(Math.abs(current.startedAt-current.plan.action.startedAt) < 1, 'renderer starts at the scheduled action time');
}

// Scan actual nontransparent canvas pixels in screen coordinates, including the
// independently rendered stretch head and the horizontally flipped yarn prop.
async function sampleAllFrames(page, expectedState) {
  return page.evaluate(expectedState => {
    const cat = document.getElementById('ccScene'), record = CCPixelCat.mount(cat);
    const plan = _ccCtrl.getIdlePlan(), progress = CCPixelCat.getProgress(cat);
    const flipped = cat.classList.contains('flip'), catRect = cat.getBoundingClientRect();
    const lane = { left:catRect.left+plan.bounds.min-plan.position, right:catRect.right+plan.bounds.max-plan.position };
    const searchTop = document.querySelector('.search-bar').getBoundingClientRect().top;
    const strip = cat.parentElement.getBoundingClientRect();
    const controls = [...document.querySelectorAll('.filter-bar .filter-label,.filter-bar .filter-tag,.filter-bar .filter-expand,#clearFilterBtn,.search-bar input,.search-bar select,.search-bar button')].filter(e => e.getClientRects().length).map(e => { const r=e.getBoundingClientRect();return { left:r.left,right:r.right,top:r.top,bottom:r.bottom }; });
    const frames = [];
    for (let index = 0; index < CCPixelCat.ANIMATIONS[expectedState].frames; index++) {
      CCPixelCat.setProgress(cat, (index+.000001)/CCPixelCat.ANIMATIONS[expectedState].frames);
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const canvas of cat.querySelectorAll('canvas')) {
        const rect = canvas.getBoundingClientRect(), data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
        for (let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) if(data[(y*canvas.width+x)*4+3]) {
          xMin=Math.min(xMin,x);xMax=Math.max(xMax,x);yMin=Math.min(yMin,y);yMax=Math.max(yMax,y);
        }
        if (xMin === Infinity) continue;
        left=Math.min(left,flipped ? rect.right-(xMax+1)/canvas.width*rect.width : rect.left+xMin/canvas.width*rect.width);
        right=Math.max(right,flipped ? rect.right-xMin/canvas.width*rect.width : rect.left+(xMax+1)/canvas.width*rect.width);
        top=Math.min(top,rect.top+yMin/canvas.height*rect.height);
        bottom=Math.max(bottom,rect.top+(yMax+1)/canvas.height*rect.height);
      }
      frames.push({ index,left,right,top,bottom,collisions:controls.filter(r=>Math.min(right,r.right)-Math.max(left,r.left)>.1 && Math.min(bottom,r.bottom)-Math.max(top,r.top)>.1).length });
    }
    CCPixelCat.setProgress(cat, progress);CCPixelCat.play(cat);
    return { state:record.state, lane, strip:{ left:strip.left,right:strip.right }, searchTop, flipped, position:plan.position, bounds:plan.bounds, frames };
  }, expectedState);
}

function assertPixels(sample, label) {
  for (const frame of sample.frames) {
    assert.ok(frame.left >= sample.lane.left-.75 && frame.right <= sample.lane.right+.75, label+': visible pixels escaped the safe lane: '+JSON.stringify({ frame, lane:sample.lane, flipped:sample.flipped }));
    assert.ok(frame.left >= sample.strip.left-.75 && frame.right <= sample.strip.right+.75, label+': visible pixels escaped the strip');
    assert.equal(frame.collisions, 0, label+': visible sprite overlaps filter or search controls');
  }
}

async function checkAction(name, expectedState) {
  const { page, context } = await openPage(1100, name);
  const first = await advanceTo(page, 10000);assertFullAction(first, name, expectedState);
  assert.equal(first.plan.phase,'walk','the first ten-second leisure beat interrupts an existing walk');
  const duration = await page.evaluate(state => CCPixelCat.ANIMATIONS[state].duration, expectedState);
  assert.equal(first.plan.action.duration, duration);
  const pixels = await sampleAllFrames(page, expectedState);assertPixels(pixels, name+' automatic action');
  await page.clock.runFor(1100);
  const midway = await state(page);assertFullAction(midway, name, expectedState);
  assert.equal(midway.plan.elapsed,first.plan.elapsed,'effective route and gesture clocks freeze during the full action');
  assert.equal(midway.plan.position,first.plan.position,'playing an action in a walk freezes the exact walking position');
  assert.equal(midway.plan.action.startedAt, first.plan.action.startedAt, 'light gestures cannot replace the full action');
  assert.ok(midway.progress > .1 && midway.progress < .5, 'animation advances instead of restarting every scheduler tick');
  await page.clock.runFor(duration-1100);
  const ended = await state(page);
  assert.equal(ended.scene, 'walk');assert.equal(ended.activity, 'idle');
  assert.equal(ended.plan.action,null,'completed full animation resumes its saved walk');
  assert.equal(ended.plan.elapsed,first.plan.elapsed);assert.equal(ended.plan.position,first.plan.position);
  await page.clock.runFor(100);
  const continued=await state(page);
  assert.equal(continued.scene,'walk');assert.ok(continued.plan.elapsed>ended.plan.elapsed);
  assert.equal(Math.sign(continued.plan.position-ended.plan.position),first.plan.direction,'the remaining walk continues in its original direction');
  passed(name+' pauses a walk, renders the actual action, completes and continues the remaining route', { duration, first:first.plan.action, bottomOffsetFromSearch:Math.max(...pixels.frames.map(frame=>frame.bottom))-pixels.searchTop });

  if (name === 'yarn') {
    const repeated = await advanceTo(page, 20000);assertFullAction(repeated,name,expectedState);
    assert.ok(repeated.plan.action.startedAt > first.plan.action.startedAt);
    assert.ok(repeated.progress < .02, 'drawing the same action again starts from its first frame');
    passed('consecutive yarn selections restart their animation clock');
  }

  await restart(page, name);const beforeTask = await advanceTo(page,10000);assertFullAction(beforeTask,name,expectedState);
  assert.equal(beforeTask.plan.phase,'walk');
  await page.clock.runFor(500);
  const takeover = await page.evaluate(() => {
    window.__leisureTaskToken = _ccActivity.begin('leisure-ui-synthetic-task','coding',100);
    return { scene:CCPixelCat.mount(document.getElementById('ccScene')).state,plan:_ccCtrl.getIdlePlan(),activity:_ccActivity.getState() };
  });
  assert.equal(takeover.scene,'coding');assert.equal(takeover.activity,'coding');assert.equal(takeover.plan.active,false);assert.equal(takeover.plan.action,null);
  const oldStartedAt=beforeTask.plan.action.startedAt;
  await advanceWall(page,duration+1000);assert.equal((await state(page)).scene,'coding');
  await page.evaluate(() => _ccActivity.cancel('leisure-ui-synthetic-task',__leisureTaskToken));
  const canceled = await state(page);assert.equal(canceled.scene,'idle');assert.equal(canceled.plan.active,true);
  assert.equal(canceled.plan.elapsed,0);assert.equal(canceled.plan.action,null);assert.equal(canceled.plan.position,takeover.plan.position);
  await page.clock.runFor(1000);
  const afterCancel=await state(page);assert.notEqual(afterCancel.plan.action?.startedAt,oldStartedAt);
  assert.equal(afterCancel.scene,'idle');
  passed(name+' yields immediately to activity-controller work and never revives its old action');

  await restart(page,name);assertFullAction(await advanceTo(page,10000),name,expectedState);await page.clock.runFor(1000);
  const hidden = await page.evaluate(() => {
    window.__leisureHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__leisureHidden});
    document.dispatchEvent(new Event('visibilitychange'));return _ccCtrl.getIdlePlan();
  });
  assert.equal(hidden.active,false);assert.equal(hidden.suspended,true);assert.equal(hidden.action,null);
  await page.clock.fastForward(20000);
  const restored = await page.evaluate(() => {
    window.__leisureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
    return { plan:_ccCtrl.getIdlePlan(),state:CCPixelCat.mount(document.getElementById('ccScene')).state };
  });
  assert.equal(restored.plan.active,true);assert.equal(restored.plan.suspended,false);assert.equal(restored.plan.position,hidden.position);
  assert.equal(restored.plan.elapsed,hidden.elapsed);assert.equal(restored.plan.epoch-hidden.epoch,20000);
  assert.equal(restored.plan.action,null);assert.equal(restored.state,'walk');
  await page.clock.runFor(50);assert.equal((await state(page)).plan.action,null,'interrupted action must not replay on returning');
  await page.evaluate(() => { delete document.hidden;delete window.__leisureHidden; });
  passed(name+' is discarded across visibility suspension while its route is frozen');
  await context.close();currentPage=null;
}

async function checkLightAction() {
  const { page,context }=await openPage(1100,'stretch-full');
  const first=await advanceTo(page,6000);
  assert.equal(first.plan.phase,'walk');assert.equal(first.plan.action?.kind,'light');assert.equal(first.scene,'idle');
  await page.clock.runFor(500);
  const paused=await state(page);
  assert.equal(paused.plan.elapsed,first.plan.elapsed);assert.equal(paused.plan.position,first.plan.position);
  assert.equal(paused.scene,'idle','light gestures also replace the walking sprite, rather than leaving it stepping in place');
  const takeover=await page.evaluate(()=>{
    window.__lightTaskToken=_ccActivity.begin('light-ui-synthetic-task','thinking',100);
    return {scene:CCPixelCat.mount(document.getElementById('ccScene')).state,plan:_ccCtrl.getIdlePlan()};
  });
  assert.equal(takeover.scene,'thinking');assert.equal(takeover.plan.active,false);assert.equal(takeover.plan.action,null);
  await page.clock.runFor(1500);assert.equal((await state(page)).scene,'thinking');
  await page.evaluate(()=>_ccActivity.cancel('light-ui-synthetic-task',__lightTaskToken));
  assert.equal((await state(page)).scene,'idle');
  passed('a light gesture freezes a walk and yields synchronously to a new task');
  await context.close();currentPage=null;
}

async function checkBoundary(width) {
  const { page, context } = await openPage(width,'yarn');
  const start = await state(page), gap = start.plan.bounds.max-start.plan.bounds.min;
  const margin = await page.evaluate(() => { const cat=document.getElementById('ccScene');return 40*cat.getBoundingClientRect().width/cat.offsetWidth; });
  if (gap < margin) {
    const skipped = await advanceTo(page,10000);
    assert.ok(skipped.draws.length>0);
    assert.ok(skipped.draws.every(draw=>!draw.candidates.includes('yarn')), 'a lane narrower than the prop margin excludes yarn');
    for (const [name,expected] of [['belly','belly'],['stretch-full','stretch']]) {
      await restart(page,name);const chosen=await advanceTo(page,10000);assertFullAction(chosen,name,expected);
      assertPixels(await sampleAllFrames(page,expected),width+' narrow '+name);
    }
    passed(width+'px narrow lane skips yarn and retains sleep/stretch', { gap,margin });
  } else {
    for (const [age,endpoint,flipped] of [[80000,'right',false],[170000,'left',true]]) {
      const chosen = await advanceTo(page,age);assertFullAction(chosen,'yarn','yarn');
      const bound = endpoint==='right' ? chosen.plan.bounds.max : chosen.plan.bounds.min;
      assert.ok(Math.abs(chosen.plan.position-bound)<.1,'the automatic route reaches its '+endpoint+' endpoint');
      assert.equal(chosen.flip,flipped,'yarn turns toward the inside of the '+endpoint+' endpoint');
      const sample = await sampleAllFrames(page,'yarn');assertPixels(sample,width+' '+endpoint+' yarn');
      await page.screenshot({ path:path.join(evidence,width+'-'+endpoint+'-yarn.png') });
      passed(width+'px '+endpoint+' endpoint contains every yarn animation pixel', { gap, margin, position:chosen.plan.position, flipped });
    }
  }
  await context.close();currentPage=null;
}

(async () => {
  fs.mkdirSync(evidence,{recursive:true});
  browser = await chromium.launch({ executablePath:process.env.MEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, args:['--disable-background-timer-throttling','--disable-renderer-backgrounding'] });
  for (const [name,state] of [['yarn','yarn'],['belly','belly'],['stretch-full','stretch']]) await checkAction(name,state);
  await checkLightAction();
  for (const width of [1100,390,320,240]) await checkBoundary(width);
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
  report.passed=true;
})().catch(async error => {
  report.error=error.stack;process.exitCode=1;console.error(error.stack);
  if (currentPage) {
    report.failureState=await state(currentPage).catch(()=>null);
    await currentPage.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  }
}).finally(async () => {
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();
  console.log(JSON.stringify({passed:report.passed || false,checks:report.checks.length,evidence,error:report.error}));
});
