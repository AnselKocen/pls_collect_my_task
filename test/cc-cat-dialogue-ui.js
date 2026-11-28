// Main-page dialogue regression with synthetic APIs and a virtual browser clock.
// Run: MEMO_PLAYWRIGHT=/path/to/playwright node test/cc-cat-dialogue-ui.js
// MEMO_CHROME overrides Chrome; no server, real records or model CLI are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.MEMO_PLAYWRIGHT || 'playwright');

const publicDir = path.join(__dirname, '../public');
const origin = 'http://memo-cat-dialogue.test';
const serviceId = 'cat-dialogue-service';
const sanctuaryBase = 'https://47.103.200.189/cat-sanctuary/';
const sanctuaryOrigin = new URL(sanctuaryBase).origin;
const sanctuaryDir = path.resolve(process.env.MEMO_CAT_STATIC_DIR || path.join(__dirname, '../output/cat-sanctuary-site'));
const themeCatalog = JSON.parse(fs.readFileSync(path.join(publicDir, 'assets/cat-sanctuary/themes/catalog.json'), 'utf8')).themes;
const priorRoomColors = { bg:'#111111', card:'#222222', accent:'#333333', text:'#EEEEEE', border:'#444444', deco:'#555555' };
const evidence = process.env.MEMO_CAT_DIALOGUE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cat-dialogue-ui-'));
const date = '2026-11-27T02:00:00.000Z';
const settings = { ...require('../storage/defaults')()['settings.json'], theme:'mintchoc', tags:['mark','待办','脑洞','链接','账号','备份','思考'], tagOrder:['mark','待办','脑洞','链接','账号','备份','思考'] };
const memos = [{ id:'dialogue-fixture', content:'小猫对话的合成记录。', tags:['mark'], createdAt:date, updatedAt:date }];
const phrases = ['记得喝水...', '(偷翻便签中)', '好多事情..', '早点休息..', '让我帮你整理一下思绪吧?', '麻烦的事情交给我', '🎵～'];
const invitation = '喵嗷，去不去咪的家里玩？';
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon' };
const report = { checks:[], errors:[], unexpectedRequests:[], sanctuaryRequests:[], fixture:'production main page, online origin mapped to the local standalone build, separate browser origins, in-memory APIs, virtual clock, no real data/model/network calls' };
let browser, currentPage;
fs.mkdirSync(evidence, { recursive:true });

function passed(name, details = {}) {
  report.checks.push({ name, ...details });
  console.log('PASS '+name);
}

async function installRoutes(context, fixture) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === sanctuaryOrigin) {
      report.sanctuaryRequests.push({ method:request.method(), url:url.href });
      if (request.method() !== 'GET' || !url.pathname.startsWith(new URL(sanctuaryBase).pathname)) {
        report.unexpectedRequests.push({ method:request.method(), url:url.href });
        return route.fulfill({ status:400, body:'Only the mapped static room may be requested' });
      }
      const relative = decodeURIComponent(url.pathname.slice(new URL(sanctuaryBase).pathname.length)) || 'index.html';
      const file = path.resolve(sanctuaryDir, relative);
      if (!file.startsWith(sanctuaryDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        report.unexpectedRequests.push({ method:request.method(), url:url.href });
        return route.fulfill({ status:404, body:'Packaged room asset not found' });
      }
      return route.fulfill({ status:200, contentType:mime[path.extname(file)] || 'application/octet-stream', body:fs.readFileSync(file) });
    }
    // Markdown and graph CDN scripts are unused by this dialogue fixture.
    if (url.origin !== origin) return route.fulfill({ status:200, contentType:'application/javascript', body:'' });
    const json = body => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        report.unexpectedRequests.push({ method:request.method(), path:url.pathname });
        return route.fulfill({ status:400, contentType:'application/json', body:'{"error":"This fixture never starts or mutates tasks"}' });
      }
      if (url.pathname === '/api/settings') return json(settings);
      if (url.pathname === '/api/tags') return json(settings.tags);
      if (url.pathname === '/api/memos') return json(memos);
      if (url.pathname === '/api/ai/status') return json({ serviceId, agent:'cc', name:'Synthetic local agent', configured:true, busy:fixture.task?.status === 'running', maintenance:false, task:fixture.task?.name || '', elapsedMs:0 });
      if (url.pathname === '/api/ai/readiness') return json({ serviceId, version:'1.0.0', checking:false, checkedAt:date, agents:[
        {id:'cc',name:'Claude Code',state:'detected',canTest:true,detail:'已检测到登录状态',test:{state:'idle'}},
        {id:'codex',name:'Codex',state:'missing',canTest:false,detail:'本机未检测到 CLI',test:{state:'idle'}},
        {id:'codebuddy',name:'CodeBuddy',state:'unknown',canTest:true,detail:'登录状态未确认',test:{state:'idle'}}
      ] });
      if (url.pathname === '/api/ai/task') return json({ streamId:'cat-dialogue-test', revision:fixture.revision, task:fixture.task });
      if (url.pathname === '/api/ai/events') return route.fulfill({ status:204, contentType:'text/event-stream', body:'' });
      if (url.pathname === '/api/cc/suggestions') return json({ dailyDigest:{ date:date.slice(0,10), summary:'合成摘要：记录小猫的新邀请。' }, weeklyDigests:[], tagSuggestions:[], graphHistory:[] });
      if (url.pathname === '/api/scheduled/pending') return json({ pending:[] });
      report.unexpectedRequests.push({ method:request.method(), path:url.pathname });
      return json({});
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status:204, body:'' });
    const file = path.resolve(publicDir, '.'+(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status:404, body:'Not found' });
    return route.fulfill({ status:200, contentType:mime[path.extname(file)] || 'application/octet-stream', body:fs.readFileSync(file) });
  });
}

async function openPage() {
  const fixture = { revision:0, task:null };
  const context = await browser.newContext({ viewport:{ width:1100, height:900 }, deviceScaleFactor:1 });
  await installRoutes(context, fixture);
  // The target site already remembers another theme/color set. Its query and
  // fragment must still win; the local app has a separate storage origin.
  await context.addInitScript(({ mainOrigin, roomOrigin, colors, serviceId }) => {
    // This regression starts after onboarding; its dedicated suite verifies
    // the startup dialogs, while these scenarios exercise the cat bubbles.
    if (location.origin === mainOrigin) {
      localStorage.setItem('memo:introduction:seen:v1','1');
      localStorage.setItem('memo:agent-readiness:dismissed',serviceId);
    }
    if (location.origin === roomOrigin) localStorage.setItem('memo:theme-selection:v1', JSON.stringify({ theme:'slate', customColors:colors, updatedAt:1, source:'previous-room-visit' }));
  }, { mainOrigin:origin, roomOrigin:sanctuaryOrigin, colors:priorRoomColors, serviceId });
  context.on('page', page => page.on('pageerror', error => report.errors.push(error.message)));
  const page = await context.newPage();currentPage = page;
  await page.clock.install({ time:new Date(date) });
  await page.goto(origin, { waitUntil:'load' });
  await page.waitForFunction(() => typeof window._ccCtrl?.getIdlePlan === 'function' && window._ccActivity.getState() === 'idle' && document.getElementById('digestText').textContent.includes('合成摘要'));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.clock.pauseAt(await page.evaluate(() => Date.now()+50));
  await page.evaluate(() => { _scheduleCCIdle();window.__dialogueStarted=Date.now(); });
  return { page, context, fixture };
}

async function sample(page) {
  return page.evaluate(() => {
    const bubble = document.getElementById('ccTaskBubble');
    const link = bubble.querySelector('.cc-cat-home');
    return {
      elapsed:Date.now()-window.__dialogueStarted,
      visible:!bubble.classList.contains('hidden') && getComputedStyle(bubble).display !== 'none',
      opacity:Number(getComputedStyle(bubble).opacity),
      kind:bubble.dataset.ccBubbleKind || null,
      text:bubble.textContent,
      message:bubble.querySelector('span')?.textContent || '',
      close:Boolean(bubble.querySelector('#ccBubbleClose')),
      taskNavigation:Boolean(bubble.querySelector('[data-ai-task-details]')),
      home:link ? { text:link.textContent, href:link.href, target:link.target, rel:link.rel, hidden:link.hidden, disabled:link.hasAttribute('disabled') } : null,
      activity:window._ccActivity.getState(), busy:window._ccActivity.isBusy()
    };
  });
}

async function advanceTo(page, elapsed) {
  let remaining = elapsed-await page.evaluate(() => Date.now()-window.__dialogueStarted);
  assert.ok(remaining >= 0, 'virtual time must advance monotonically');
  // Fast-forward fires a repeating timer once per jump. Small steps preserve
  // every 30-second opportunity and each 10/2.5-second expiry independently.
  while (remaining > 0) {
    const step = Math.min(5000, remaining);
    await page.clock.fastForward(step);
    remaining -= step;
  }
  return sample(page);
}

function homeUrl(theme = 'mintchoc', colors) {
  const url = new URL(sanctuaryBase);url.searchParams.set('theme', theme);
  if (colors) url.hash = 'colors='+['bg','card','accent','text','border','deco'].map(key=>colors[key].slice(1).toUpperCase()).join('-');
  return url.href;
}

function assertInvitation(state, expectedHref = homeUrl()) {
  assert.equal(state.visible, true, JSON.stringify(state));
  assert.equal(state.kind, 'invitation');
  assert.equal(state.message, invitation);
  assert.equal(state.close, false, 'invitations have no close button');
  assert.equal(state.taskNavigation, false, 'the home link must not inherit task navigation');
  assert.deepEqual(state.home, { text:'前往', href:expectedHref, target:'_blank', rel:'noopener', hidden:false, disabled:false });
}

function assertChatter(state) {
  assert.equal(state.visible, true, JSON.stringify(state));
  assert.equal(state.kind, 'chatter');
  assert.ok(phrases.includes(state.message), 'chatter uses the existing phrase pool: '+state.message);
  assert.equal(state.close, false);
  assert.equal(state.home, null);
  assert.equal(state.taskNavigation, false);
}

async function settleBubble(page) {
  await page.clock.runFor(300);
  // CSS animations use Chromium's document timeline, so also allow real
  // compositor time to pass while the virtual dialogue timers remain paused.
  await page.waitForTimeout(350);
  assert.equal((await sample(page)).opacity, 1, 'the bubble must finish its normal pop-in animation and visibly render');
}

async function checkCadence() {
  const { page, context, fixture } = await openPage();
  assert.equal((await advanceTo(page, 29999)).visible, false);
  const first = await advanceTo(page, 30000);assertInvitation(first);
  await settleBubble(page);
  await page.screenshot({ path:path.join(evidence, 'invitation.png') });
  const clip = await page.evaluate(() => {
    const bounds = ['ccTaskBubble', 'ccScene'].map(id => document.getElementById(id).getBoundingClientRect());
    const x = Math.max(0, Math.min(...bounds.map(r => r.left))-12), y = Math.max(0, Math.min(...bounds.map(r => r.top))-12);
    return { x, y, width:Math.min(innerWidth, Math.max(...bounds.map(r => r.right))+12)-x, height:Math.min(innerHeight, Math.max(...bounds.map(r => r.bottom))+12)-y };
  });
  await page.screenshot({ path:path.join(evidence, 'invitation-detail.png'), clip });
  // A fresh accepted snapshot and navigation render must not replace the home
  // link or restart the dialogue clock while the invitation is already shown.
  ++fixture.revision;
  await page.evaluate(async () => { await window.refreshCurrentAITask();window.updateAITaskNavigation(); });
  assertInvitation(await sample(page));
  assert.equal((await advanceTo(page, 39999)).visible, true);
  assert.equal((await advanceTo(page, 40000)).visible, false);
  assert.equal((await advanceTo(page, 59999)).visible, false);
  assertInvitation(await advanceTo(page, 60000));
  assert.equal((await advanceTo(page, 70000)).visible, false);
  assert.equal((await advanceTo(page, 89999)).visible, false);
  const chatter = await advanceTo(page, 90000);assertChatter(chatter);
  await settleBubble(page);
  await page.screenshot({ path:path.join(evidence, 'chatter.png') });
  assert.equal((await advanceTo(page, 92499)).visible, true);
  assert.equal((await advanceTo(page, 92500)).visible, false);
  assertInvitation(await advanceTo(page, 120000));
  assertInvitation(await advanceTo(page, 150000));
  assertChatter(await advanceTo(page, 180000));
  passed('30/60-second invitations last 10 seconds; 90-second chatter lasts 2.5 seconds; the next cycle stays on time', { first, chatter });
  passed('accepted task snapshots and task navigation renders preserve the independent home link');
  await context.close();
}

async function checkLocalTask() {
  const { page, context } = await openPage();
  assertInvitation(await advanceTo(page, 30000));
  await advanceTo(page, 35000);
  await page.evaluate(() => showCCTask('合成整理任务', { type:'graph' }));
  let task = await sample(page);
  assert.equal(task.kind, 'task');assert.equal(task.busy, true);assert.ok(task.message.includes('合成整理任务'));
  assert.equal(task.home, null);
  const afterOldExpiry = await advanceTo(page, 40000);
  assert.equal(afterOldExpiry.visible, true, 'the replaced invitation cannot hide a running task at its old expiry');
  assert.equal(afterOldExpiry.message, task.message);
  assert.equal((await advanceTo(page, 125000)).message, task.message, 'tasks suppress multiple dialogue opportunities');
  await page.evaluate(() => hideCCTask('合成整理任务'));
  task = await advanceTo(page, 129000);
  assert.equal(task.kind, 'task');assert.equal(task.busy, false);assert.equal(task.close, true);assert.ok(task.message.includes('已完成'));
  const held = await advanceTo(page, 219000);
  assert.equal(held.visible, true);assert.equal(held.message, task.message, 'a completed task owns the bubble until X');
  await settleBubble(page);
  await page.screenshot({ path:path.join(evidence, 'completed-task.png') });
  await page.evaluate(() => document.getElementById('ccScene').click());
  assert.equal((await sample(page)).busy, true, 'a cat greeting may be playing when the user closes the completed task');
  await page.evaluate(() => { document.getElementById('ccBubbleClose').click();window.__dialogueStarted=Date.now(); });
  assert.equal((await advanceTo(page, 29999)).visible, false, 'closing X waits a complete fresh 30 seconds');
  const resumed = await advanceTo(page, 30000);assertInvitation(resumed);
  assertInvitation(await advanceTo(page, 60000));
  assertChatter(await advanceTo(page, 90000));
  passed('local tasks replace invitations and cancel their expiry; X restarts the full cycle even during a cat greeting', { afterOldExpiry, resumed });
  await context.close();
}

async function checkRemoteFailure() {
  const { page, context, fixture } = await openPage();
  assertInvitation(await advanceTo(page, 30000));
  await advanceTo(page, 35000);
  fixture.task = { id:'remote-dialogue-test', name:'合成周总结', status:'running', stage:'正在生成合成周总结', messages:[], target:{ type:'weekly-digest' } };
  ++fixture.revision;
  await page.evaluate(() => window.refreshCurrentAITask());
  const running = await advanceTo(page, 40000);
  assert.equal(running.kind, 'task');assert.equal(running.visible, true);assert.ok(running.message.includes('合成周总结'));
  await advanceTo(page, 95000);
  fixture.task = { ...fixture.task, status:'failed', error:'合成失败提示' };
  ++fixture.revision;
  await page.evaluate(() => window.refreshCurrentAITask());
  const failed = await advanceTo(page, 99000);
  assert.equal(failed.message, '合成失败提示');assert.equal(failed.close, true);assert.equal(failed.busy, false);
  assert.equal((await advanceTo(page, 189000)).message, failed.message);
  await page.evaluate(() => { document.getElementById('ccBubbleClose').click();window.__dialogueStarted=Date.now(); });
  await advanceTo(page, 10000);
  ++fixture.revision;
  await page.evaluate(() => window.refreshCurrentAITask());
  assert.equal((await advanceTo(page, 29999)).visible, false);
  assertInvitation(await advanceTo(page, 30000));
  passed('remote task snapshots also stop dialogues; failures stay until X and repeated terminal snapshots do not restart the new clock', { running, failed });
  await context.close();
}

async function checkHiddenPage() {
  const { page, context } = await openPage();
  await advanceTo(page, 10000);
  // Keep the virtual timers runnable while presenting the same visibility
  // signal read by the production scheduler and task polling listeners.
  await page.evaluate(() => {
    window.__dialogueHidden=true;
    Object.defineProperty(document, 'hidden', { configurable:true, get:() => window.__dialogueHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await advanceTo(page, 95000)).visible, false);
  await page.evaluate(() => { window.__dialogueHidden=false;document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal((await sample(page)).visible, false, 'returning to the page must not replay missed invitations');
  assert.equal((await advanceTo(page, 119999)).visible, false);
  assertInvitation(await advanceTo(page, 120000));
  passed('hidden-page opportunities are skipped; returning does not replay missed messages or move the next slot');
  await context.close();
}

async function roomState(popup) {
  await popup.waitForLoadState('load');
  await popup.evaluate(() => CatRoomThemes.ready);
  await popup.waitForFunction(() => !CatRoomThemes.snapshot().busy && document.getElementById('room').complete && document.getElementById('room').naturalWidth === 1254);
  return popup.evaluate(() => ({
    origin:location.origin, pathname:location.pathname, search:location.search, hash:location.hash,
    local:document.documentElement.dataset.roomSettings, domTheme:document.documentElement.getAttribute('data-theme'),
    selected:document.getElementById('roomThemeSelect').value, domImage:document.getElementById('room').getAttribute('src'),
    loaded:document.getElementById('room').complete, width:document.getElementById('room').naturalWidth,
    saved:MemoThemeSync.read(), ...CatRoomThemes.snapshot()
  }));
}

function assertRoom(state, theme, image) {
  assert.equal(state.origin, sanctuaryOrigin);assert.equal(state.pathname, new URL(sanctuaryBase).pathname);
  assert.equal(state.local, 'local');assert.equal(state.theme, theme);assert.equal(state.domTheme, theme);assert.equal(state.selected, theme);
  assert.equal(state.loaded, true);assert.equal(state.width, 1254);assert.equal(state.image, image);assert.equal(state.domImage, image);
  assert.equal(state.saved.theme, 'slate', 'the previous website selection must not override an invitation query');
}

async function openInvitedRoom(page, expectedHref) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#ccTaskBubble .cc-cat-home').click({ force:true })
  ]);
  await popup.waitForURL(target => target.origin===sanctuaryOrigin, {waitUntil:'load'});
  assert.equal(popup.url(), expectedHref);
  const state = await roomState(popup);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(await page.locator('#memoInput').inputValue(), '尚未保存的合成草稿');
  return { popup, state };
}

async function checkHomeNavigation() {
  const { page, context } = await openPage();
  await page.locator('#memoInput').fill('尚未保存的合成草稿');
  assertInvitation(await advanceTo(page, 30000));await settleBubble(page);
  assert.equal(themeCatalog.length, 24);
  const mappings = [];
  for (const { key } of themeCatalog) {
    const mapping = await page.evaluate(key => {
      applyTheme(key);
      return { key, settingsTheme:settings.theme, domTheme:document.documentElement.getAttribute('data-theme'), helper:_ccSanctuaryUrl(), link:document.querySelector('#ccTaskBubble .cc-cat-home').href };
    }, key);
    assert.equal(mapping.settingsTheme, 'mintchoc', 'the DOM can change while async settings still contain the old theme');
    assert.equal(mapping.helper, homeUrl(key));assert.equal(mapping.link, homeUrl(key));mappings.push(mapping);
  }
  const alias = await page.evaluate(() => { applyTheme('pink');return document.querySelector('#ccTaskBubble .cc-cat-home').href; });
  assert.equal(alias, homeUrl('berry'));
  const visibleChanges = [];
  for (const key of ['mintchoc','gold','berry']) {
    await page.evaluate(key => applyTheme(key), key);
    const state = await sample(page);assertInvitation(state, homeUrl(key));visibleChanges.push({ key, state });
  }
  // An accepted selection from another local-app window takes the subscriber
  // path (receivingSharedTheme=true), which must update a visible link too.
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
    key:'memo:theme-selection:v1', newValue:JSON.stringify({theme:'gold',updatedAt:Date.now()+10000,source:'another-local-app-window'})
  })));
  assertInvitation(await sample(page), homeUrl('gold'));
  passed('all 24 preset URLs and pink alias map correctly; visible invitations follow DOM and received themes even while settings lag', { mappings, alias, visibleChanges });

  const opened = [];
  for (const key of ['gold','mintchoc','berry']) {
    await page.evaluate(key => { settings.theme='mintchoc';applyTheme(key); }, key);
    assertInvitation(await sample(page), homeUrl(key));
    const { popup, state } = await openInvitedRoom(page, homeUrl(key));
    assertRoom(state, key, themeCatalog.find(theme => theme.key===key).image);
    assert.notEqual(await page.evaluate(() => MemoThemeSync.read().theme), state.saved.theme, 'the app and website must have independent localStorage');
    await popup.waitForTimeout(350);await popup.screenshot({path:path.join(evidence,'popup-'+key+'.png')});
    opened.push(state);await popup.close();
  }
  // Bypass publication to simulate a DOM change at the instant of clicking.
  // The anchor is deliberately stale until its actual click listener runs.
  await page.evaluate(() => { settings.theme='gold';applyTheme('mintchoc');document.documentElement.setAttribute('data-theme','berry'); });
  assertInvitation(await sample(page), homeUrl('mintchoc'));
  const rechecked = await openInvitedRoom(page, homeUrl('berry'));
  assertRoom(rechecked.state, 'berry', themeCatalog.find(theme => theme.key==='berry').image);
  await rechecked.popup.close();
  passed('cross-origin clicks open the requested preset despite a different saved website theme, re-read the DOM on click, and preserve the main-page draft', { opened, rechecked:rechecked.state });
  await context.close();
}

async function checkCustomHomeNavigation() {
  const { page, context } = await openPage();
  await page.locator('#memoInput').fill('尚未保存的合成草稿');
  assertInvitation(await advanceTo(page, 30000));await settleBubble(page);
  const berry = themeCatalog.find(theme => theme.key==='berry');
  // Matching berry's accent+decoration gives a known closest room; the other
  // four values are distinct so all six fragment fields can be checked.
  const colors = { bg:'#13283d', card:'#243f51', accent:berry.palette['--t-primary'].toLowerCase(), text:'#dbe6f0', border:'#416b87', deco:berry.palette['--t-secondary'].toLowerCase() };
  const source = await page.evaluate(({colors,previous}) => {
    settings.theme='gold';settings.customColors=previous;applyCustomTheme(colors);
    const style=getComputedStyle(document.documentElement);
    return {settingsTheme:settings.theme,settingsColors:settings.customColors,border:style.getPropertyValue('--t-border').trim(),borderLight:style.getPropertyValue('--t-border-light').trim(),href:document.querySelector('#ccTaskBubble .cc-cat-home').href};
  }, { colors, previous:priorRoomColors });
  assert.equal(source.settingsTheme, 'gold');assert.deepEqual(source.settingsColors, priorRoomColors);
  assert.notEqual(source.border.toUpperCase(), source.borderLight.toUpperCase(), 'the fixture distinguishes the true border from its light derivative');
  const expectedHref = homeUrl('custom', colors);assert.equal(source.href, expectedHref);
  assert.equal(new URL(source.href).hash.slice('#colors='.length).split('-')[4], colors.border.slice(1).toUpperCase());
  assertInvitation(await sample(page), expectedHref);
  const { popup, state } = await openInvitedRoom(page, expectedHref);
  assertRoom(state, 'custom', berry.image);assert.equal(state.sceneTheme, 'berry');
  for (const [key,token] of Object.entries({bg:'--t-bg',card:'--t-card',accent:'--t-primary',text:'--t-text',border:'--t-border'})) assert.equal(state.palette[token].toUpperCase(), colors[key].toUpperCase());
  assert.equal(state.hash, new URL(expectedHref).hash);
  await popup.waitForTimeout(350);await popup.screenshot({path:path.join(evidence,'popup-custom.png')});await popup.close();
  passed('custom invitations encode six current DOM colors in uppercase fragment fields, use the true border, and override previously saved website colors', { source, expectedHref, room:state });

  const invalid = [];
  for (const hash of ['#colors=123456-abcdef', '#colors=000000-FFFFFF-123456-ABCDEF-777777-GGGGGG', '#colors=%E0%A4%A']) {
    const room = await context.newPage();
    await room.goto(homeUrl('custom')+hash, {waitUntil:'load'});
    const fallback = await roomState(room);assert.equal(fallback.theme, 'custom');assert.equal(fallback.domTheme, 'custom');assert.equal(fallback.error, null);
    for (const [key,token] of Object.entries({bg:'--t-bg',card:'--t-card',accent:'--t-primary',text:'--t-text',border:'--t-border'})) assert.equal(fallback.palette[token].toUpperCase(), priorRoomColors[key].toUpperCase());
    invalid.push({hash,theme:fallback.theme,palette:fallback.palette});await room.close();
  }
  assert.ok(report.sanctuaryRequests.some(request => new URL(request.url).searchParams.get('theme')==='custom'));
  for (const request of report.sanctuaryRequests) {
    assert.equal(new URL(request.url).hash, '', 'palette fragments must never be transmitted in HTTP requests');
    assert.equal(new URL(request.url).searchParams.has('colors'), false);
  }
  passed('malformed color fragments do not throw and retain valid saved colors; custom fragments stay out of every HTTP request', { invalid });
  await context.close();
}

(async () => {
  try {
    assert.ok(fs.existsSync(path.join(sanctuaryDir, 'index.html')), 'build the standalone room before running its cross-origin dialogue checks');
    browser = await chromium.launch({ executablePath:process.env.MEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, args:['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    await checkCadence();
    await checkLocalTask();
    await checkRemoteFailure();
    await checkHiddenPage();
    await checkHomeNavigation();
    await checkCustomHomeNavigation();
    assert.deepEqual(report.errors, [], 'production pages must not throw renderer errors');
    assert.deepEqual(report.unexpectedRequests, [], 'the fixture must never reach unexpected or mutation APIs');
    console.log('Dialogue evidence: '+evidence);
  } catch (error) {
    report.failure = error.stack || String(error);
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path:path.join(evidence, 'failure.png') }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
  }
})();
