// Production main-page onboarding checks with isolated, in-memory APIs.
// Run: MEMO_PLAYWRIGHT=/path/to/playwright node test/onboarding-ui.js
// MEMO_CHROME overrides Chrome. No server, real records, CLI or model is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.MEMO_PLAYWRIGHT || 'playwright');

const publicDir = path.join(__dirname, '../public');
const origin = 'http://memo-onboarding.test';
const evidence = process.env.MEMO_ONBOARDING_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'memo-onboarding-ui-'));
const date = '2026-11-28T04:00:00.000Z';
const repositoryUrl = 'https://github.com/AnselKocen/pls_collect_my_task';
const welcomeDescription = [
  '记忆手帐Memo Journal是一款结合本地记录与 AI 整理的便签和任务助手。',
  '你可以把它当作简单的记事本，随手记录想法、心情和待办；也可以让 AI 帮你整理记录、生成摘要、梳理任务和养成习惯。',
  '日常记录无需 AI。 使用 AI 功能，需要本机已安装下列任一助手的 CLI，并完成登录或认证配置。',
  '下方会显示本机助手的基础检测结果。你可以手动测试连接。'
];
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon' };
const report = { checks:[], errors:[], unexpectedRequests:[], fixture:'production main page, all APIs in memory, no real records, CLI, model, or external requests' };
let browser, currentPage;
fs.mkdirSync(evidence, { recursive:true });

function passed(name, details = {}) {
  report.checks.push({ name, ...details });
  console.log('PASS '+name);
}

function createFixture(options = {}) {
  const names = { cc:'Claude Code', codex:'Codex', codebuddy:'CodeBuddy' };
  const states = options.states || { cc:'detected', codex:'missing', codebuddy:'unknown' };
  const settings = { ...require('../storage/defaults')()['settings.json'], theme:options.theme || 'mintchoc', tags:['记录'], tagOrder:['记录'] };
  if (settings.theme === 'custom') settings.customColors = { bg:'#18242D', card:'#243744', accent:'#A3CF90', text:'#E9F4EC', border:'#678277', deco:'#A3CF90' };
  return {
    settings, memos:[], tests:[], refreshes:0, readinessReads:0, mutations:[],
    testOutcome:'success', failReadiness:false, failTestRequest:false, testDelayMs:0,
    readiness:{ serviceId:'onboarding-service-1', version:'1.0.0', checking:Boolean(options.checking), checkedAt:date,
      agents:Object.entries(names).map(([id,name]) => ({
        id, name, state:states[id], canTest:['detected','unknown'].includes(states[id]),
        detail:{ missing:'本机未检测到 CLI', logged_out:'未检测到登录状态', detected:'已检测到登录状态', unknown:'已检测到 CLI，登录状态未确认' }[states[id]],
        test:{ state:'idle' }
      })) }
  };
}

async function installRoutes(context, fixture) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) {
      // Existing graph and Markdown CDN scripts are unused by these scenarios.
      return route.fulfill({ status:200, contentType:'application/javascript', body:'' });
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/ai/readiness' && method === 'GET') {
        ++fixture.readinessReads;
        return fixture.failReadiness ? json({ error:'合成检测暂时不可用' },503) : json(fixture.readiness);
      }
      if (url.pathname === '/api/ai/readiness/refresh' && method === 'POST') {
        ++fixture.refreshes;
        fixture.readiness.checkedAt = new Date(Date.now()).toISOString();
        return json(fixture.readiness);
      }
      if (url.pathname === '/api/ai/readiness/test' && method === 'POST') {
        const body = request.postDataJSON();fixture.tests.push(body);
        const agent = fixture.readiness.agents.find(agent => agent.id === body.agent);
        if (!agent?.canTest) return json({ error:'该助手目前不能测试' },400);
        if (fixture.testDelayMs) await new Promise(resolve=>setTimeout(resolve,fixture.testDelayMs));
        if (fixture.failTestRequest) return json({ error:'合成测试请求失败' },503);
        agent.test = { state:fixture.testOutcome, checkedAt:new Date(Date.now()).toISOString(), message:fixture.testOutcome === 'success' ? '连接成功' : '合成连接暂时失败，请稍后重试' };
        return json(fixture.readiness);
      }
      if (url.pathname === '/api/settings' && method === 'GET') return json(fixture.settings);
      if (url.pathname === '/api/tags' && method === 'GET') return json(fixture.settings.tags);
      if (url.pathname === '/api/memos' && method === 'GET') return json(fixture.memos);
      if (url.pathname === '/api/memos' && method === 'POST') {
        const body = request.postDataJSON();fixture.mutations.push({path:url.pathname,body});
        const memo = { id:'synthetic-'+(fixture.memos.length+1), ...body, createdAt:date, updatedAt:date };
        fixture.memos.push(memo);return json(memo);
      }
      if (url.pathname === '/api/ai/status' && method === 'GET') return json({ serviceId:fixture.readiness.serviceId, agent:fixture.settings.agent, name:'Synthetic local agent', configured:fixture.readiness.agents.find(agent=>agent.id===fixture.settings.agent)?.canTest || false, busy:false, maintenance:false, task:'', elapsedMs:0 });
      if (url.pathname === '/api/ai/task' && method === 'GET') return json({ streamId:'onboarding-test', revision:0, task:null });
      if (url.pathname === '/api/ai/events' && method === 'GET') return route.fulfill({ status:204, contentType:'text/event-stream', body:'' });
      if (url.pathname === '/api/cc/suggestions' && method === 'GET') return json({ dailyDigest:null, weeklyDigests:[], tagSuggestions:[], graphHistory:[] });
      if (url.pathname === '/api/scheduled/pending' && method === 'GET') return json({ pending:[] });
      report.unexpectedRequests.push({ method, path:url.pathname });
      return json({ error:'Unexpected fixture API' },400);
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status:204, body:'' });
    const file = path.resolve(publicDir, '.'+(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      report.unexpectedRequests.push({ method, path:url.pathname });
      return route.fulfill({ status:404, body:'Not found' });
    }
    return route.fulfill({ status:200, contentType:mime[path.extname(file)] || 'application/octet-stream', body:fs.readFileSync(file) });
  });
}

async function openPage(options = {}) {
  const fixture = createFixture(options);
  const context = await browser.newContext({ viewport:options.viewport || { width:1200, height:920 }, deviceScaleFactor:1, reducedMotion:'reduce' });
  await installRoutes(context, fixture);
  context.on('page', page => page.on('pageerror', error => report.errors.push(error.message)));
  const page = await context.newPage();currentPage = page;
  await load(page);
  return { page, context, fixture };
}

async function load(page) {
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/readiness'),
    page.goto(origin, { waitUntil:'load' })
  ]);
  await page.waitForFunction(() => typeof window._ccCtrl?.getIdlePlan === 'function');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function visible(page, selector, expected = true) {
  await page.locator(selector).waitFor({ state:expected ? 'visible' : 'hidden' });
}

async function assertReadinessOnly(page) {
  await visible(page,'#agentReadinessModal');await visible(page,'#guideModal',false);
}

async function guideThenReadiness(page, close = 'button') {
  await assertReadinessOnly(page);
  const before = await page.locator('#readinessAgents').textContent();
  await page.locator('#readinessGuideOpen').click();
  await visible(page,'#guideModal');await visible(page,'#agentReadinessModal',false);
  if (close === 'escape') await page.keyboard.press('Escape');
  else if (close === 'backdrop') await page.locator('#guideModal').click({position:{x:5,y:5}});
  else if (close === 'x') await page.locator('#guideClose').click();
  else await page.locator('#guideOk').click();
  await assertReadinessOnly(page);
  assert.equal(await page.locator('#readinessAgents').textContent(),before,'viewing the guide preserves the current agent and test results');
  assert.equal(await page.locator('#readinessGuideOpen').evaluate(element=>element===document.activeElement),true,'closing the guide restores focus to its link in the detection dialog');
}

async function assertFocusedWithin(page, selector) {
  assert.equal(await page.locator(selector).evaluate(element=>element.contains(document.activeElement)),true,'keyboard focus must stay in the active dialog');
}

async function assertHelpMotion(page) {
  await page.emulateMedia({reducedMotion:'no-preference'});
  const motion = await page.locator('#btnHelp').evaluate(element=>element.getAnimations({subtree:true}).map(animation=>({
    name:animation.animationName,
    duration:animation.effect.getTiming().duration,
    translations:animation.effect.getKeyframes().map(frame=>new DOMMatrix(frame.transform==='none' ? undefined : frame.transform).m42)
  })));
  assert.ok(motion.length>0,'footer help has a gentle float when motion is enabled');
  assert.ok(motion.every(animation=>animation.duration>=3500 && animation.duration<=4500),'help animation takes approximately four seconds');
  assert.ok(motion.every(animation=>animation.translations.every(y=>Math.abs(y)<=1)),'help keyframes stay within one pixel vertically');
  assert.ok(motion.some(animation=>animation.translations.some(y=>y!==0)),'float animation has a small vertical displacement');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#btnHelp').evaluate(element=>element.getAnimations({subtree:true}).some(animation=>animation.playState==='running')),false,'reduced-motion stops the decorative help float');
  return motion;
}

async function checkIntroAndManualTests() {
  const { page, context, fixture } = await openPage();
  await assertReadinessOnly(page);
  assert.equal(await page.evaluate(()=>localStorage.getItem('memo:introduction:seen:v1')),null,'first entry needs no introduction-seen flag');
  const paragraphs = await page.locator('#readinessDescription > p').evaluateAll(elements=>elements.map(element=>{
    const copy=element.cloneNode(true);copy.querySelectorAll('.welcome-paw').forEach(paw=>paw.remove());
    return copy.textContent.replace(/\s+/g,' ').trim();
  }));
  assert.deepEqual(paragraphs,welcomeDescription,'welcome copy uses the four requested paragraphs');
  assert.deepEqual(await page.locator('#readinessDescription > p').evaluateAll(elements=>elements.map(element=>element.querySelectorAll('.welcome-paw').length)),[1,1,2,2],'each of the six sentences starts with one paw');
  assert.equal(await page.locator('#readinessDescription .welcome-paw').evaluateAll(elements=>elements.every(element=>element.textContent==='🐾' && element.getAttribute('aria-hidden')==='true')),true,'decorative paws stay hidden from assistive reading');
  assert.equal(await page.locator('#readinessDescription strong').evaluate(element=>{
    const copy=element.cloneNode(true);copy.querySelectorAll('.welcome-paw').forEach(paw=>paw.remove());return copy.textContent.trim();
  }),'日常记录无需 AI。');
  assert.equal(await page.locator('#agentReadinessOk').textContent(),'好的，我明白了。');
  const header = await page.locator('#readinessCatIcon').evaluate(element=>({
    loaded:element.complete && element.naturalWidth>0,
    iconPath:new URL(element.currentSrc).pathname,
    faviconPath:new URL(document.querySelector('link[rel="icon"][type="image/svg+xml"]').href).pathname,
    image:element.getBoundingClientRect().toJSON(),
    title:document.getElementById('agentReadinessTitle').getBoundingClientRect().toJSON(),
    guide:document.getElementById('readinessGuideOpen').getBoundingClientRect().toJSON()
  }));
  assert.equal(header.loaded,true,'welcome cat icon loads');
  assert.equal(header.iconPath,header.faviconPath,'welcome cat reuses the same SVG as the page favicon');
  assert.ok(header.image.left<header.title.left,'cat head sits to the left of the welcome title');
  assert.ok(header.guide.left>header.title.left,'detailed-guide link sits to the right of the welcome title');
  assert.equal(await page.locator('#readinessGuideOpen').textContent(),'查看详细指南');
  const footer = await page.locator('#btnHelp').evaluate(element=>({
    inFooter:Boolean(element.closest('.app-footer')),
    svg:Boolean(element.querySelector('svg')),
    pixels:element.querySelectorAll('svg rect,svg path,svg polygon').length,
    circle:Boolean(element.querySelector('svg circle')) || getComputedStyle(element).borderRadius==='50%' && parseFloat(getComputedStyle(element).borderTopWidth)>0,
    color:getComputedStyle(element.querySelector('svg')).color,
    button:element.getBoundingClientRect().toJSON(),
    footer:element.closest('.app-footer')?.getBoundingClientRect().toJSON(),
    copyright:document.querySelector('.app-copyright').getBoundingClientRect().toJSON()
  }));
  assert.equal(footer.inFooter,true,'help belongs to the footer');assert.equal(footer.svg,true,'help uses a pixel SVG');assert.ok(footer.pixels>0);
  assert.equal(footer.circle,true,'the pixel question SVG sits within a visible circular outline');
  assert.match(footer.color,/^rgba?\(255, 255, 255(?:, (?:1|0\.9\d*))?\)$/,'the footer help icon is bright white');
  assert.ok(footer.button.top>=footer.footer.top-1 && footer.button.bottom<=footer.footer.bottom+1,'help fits inside the footer rather than floating above it');
  assert.ok(footer.button.left<footer.footer.width/2,'help stays on the left side of the footer');
  assert.ok(Math.abs(footer.button.y+footer.button.height/2-footer.copyright.y-footer.copyright.height/2)<=2,'desktop help and copyright have aligned vertical centers');
  await assertHelpMotion(page);
  assert.equal(fixture.tests.length,0,'startup performs no model connection test');
  await page.screenshot({path:path.join(evidence,'readiness-desktop.png')});

  await page.locator('#readinessGuideOpen').click();
  await visible(page,'#guideModal');
  await visible(page,'#agentReadinessModal',false);
  const intro = await page.locator('#guideModal').textContent();
  assert.ok(intro.length>250,'the optional detailed guide explains the app in some detail');
  for (const phrase of ['记录','AI','CLI','版本']) assert.ok(intro.includes(phrase),'introduction includes '+phrase);
  assert.match(intro,/项目介绍|功能介绍/,'detailed guide uses an objective project or feature introduction');
  const repository = page.locator('#guideModal a[href="'+repositoryUrl+'"]');
  assert.equal(await repository.count(),1,'detailed guide links to the actual project repository');
  assert.equal(await repository.getAttribute('target'),'_blank');
  const rel=(await repository.getAttribute('rel') || '').split(/\s+/);
  for (const value of ['noopener','noreferrer']) assert.ok(rel.includes(value),'repository link includes '+value);
  assert.ok(await page.locator('#guideModal .guide-banner .tape').count()>0,'guide retains its paper and tape layout');
  assert.equal(await page.locator('#guideModal [role="dialog"]').count() + await page.locator('#guideModal[role="dialog"]').count(),1,'introduction is an accessible dialog');
  await assertFocusedWithin(page,'#guideModal');
  await page.locator('#guideOk').focus();await page.keyboard.press('Tab');await assertFocusedWithin(page,'#guideModal');
  await page.keyboard.press('Shift+Tab');await assertFocusedWithin(page,'#guideModal');
  await page.locator('#guideModal .guide-body').evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:path.join(evidence,'introduction-desktop.png')});
  await page.locator('#guideOk').click();await assertReadinessOnly(page);
  assert.equal(await page.locator('#readinessGuideOpen').evaluate(element=>element===document.activeElement),true);
  const detector = page.locator('#agentReadinessModal');
  for (const name of ['Claude Code','Codex','CodeBuddy']) assert.ok((await detector.textContent()).includes(name));
  assert.equal(await detector.locator('[data-readiness-agent]').count(),3);
  assert.equal(await detector.locator('[data-test-agent="codex"]').count(),0,'missing CLI has no connection test');
  assert.equal(await detector.locator('[data-test-agent="cc"]').isEnabled(),true);
  assert.equal(await detector.locator('[data-test-agent="codebuddy"]').isEnabled(),true,'unknown auth may be checked explicitly');
  assert.ok((await detector.textContent()).includes('未确认'));
  assert.match(await detector.textContent(),/额度|用量/);
  assert.match(await detector.textContent(),/记录.*搜索|搜索.*记录/s);
  assert.equal(fixture.tests.length,0,'startup performs no model connection test');
  await page.locator('#readinessRefresh').click();
  await page.waitForFunction(()=>!document.getElementById('readinessRefresh').disabled);
  assert.equal(fixture.refreshes,1);assert.equal(fixture.tests.length,0,'refresh is basic-only');
  fixture.testOutcome='failed';
  await detector.locator('[data-test-agent="cc"]').click();
  await detector.getByText('合成连接暂时失败，请稍后重试',{exact:false}).waitFor();
  fixture.testOutcome='success';
  await detector.locator('[data-test-agent="cc"]').click();
  await detector.locator('[data-readiness-agent="cc"]').getByText('连接成功',{exact:false}).first().waitFor();
  await detector.locator('[data-test-agent="codebuddy"]').click();
  await detector.locator('[data-readiness-agent="codebuddy"]').getByText('连接成功',{exact:false}).first().waitFor();
  assert.deepEqual(fixture.tests.map(test=>test.agent),['cc','cc','codebuddy']);
  assert.equal(fixture.settings.agent,'cc','testing a different assistant does not change the selected agent');
  assert.equal(fixture.mutations.length,0);
  await guideThenReadiness(page,'x');
  assert.equal(await page.evaluate(()=>localStorage.getItem('memo:introduction:seen:v1')),null,'the obsolete first-introduction flag is not written');
  passed('welcome is the only automatic dialog; optional guide preserves results and focus, exact copy, cat favicon, footer SVG, and explicit tests');

  await page.locator('#agentReadinessOk').click();await visible(page,'#agentReadinessModal',false);
  assert.equal(await page.locator('#btnHelp').evaluate(element=>element===document.activeElement),true,'dismissal returns focus to help');
  await load(page);await visible(page,'#guideModal',false);await visible(page,'#agentReadinessModal',false);
  fixture.readiness.serviceId='onboarding-service-2';
  await visible(page,'#agentReadinessModal');await visible(page,'#guideModal',false);
  await page.locator('#agentReadinessOk').click();
  fixture.readiness.serviceId='onboarding-service-3';
  await page.evaluate(()=>localStorage.setItem('memo:introduction:seen:v1','1'));
  await load(page);await visible(page,'#agentReadinessModal');await visible(page,'#guideModal',false);
  await page.keyboard.press('Escape');await visible(page,'#agentReadinessModal',false);
  await load(page);await visible(page,'#agentReadinessModal',false);
  await page.locator('#btnHelp').click();await assertReadinessOnly(page);await guideThenReadiness(page,'escape');
  await page.locator('#agentReadinessOk').click();
  await page.locator('#btnGuide').click();await assertReadinessOnly(page);await guideThenReadiness(page,'backdrop');
  await page.locator('#agentReadinessClose').click();await visible(page,'#agentReadinessModal',false);
  await page.screenshot({path:path.join(evidence,'footer-help-desktop.png')});
  assert.equal(fixture.tests.length,3,'refreshes, service restarts, help and closing never start extra tests');
  passed('each service shows only welcome once; footer and legacy help open welcome, and all guide close methods return to it');
  await context.close();
}

async function checkNoAIRecords() {
  const { page, context, fixture } = await openPage({states:{cc:'logged_out',codex:'missing',codebuddy:'missing'}});
  await assertReadinessOnly(page);
  const detector = page.locator('#agentReadinessModal');
  assert.equal(await detector.locator('[data-test-agent]').count(),0,'logged-out and missing assistants have no model test');
  assert.match(await detector.textContent(),/未检测到[^。\n]*登录状态/);
  await page.locator('#agentReadinessOk').click();
  const content='没有 AI 也可以写下这条合成记录。';
  await page.locator('#memoInput').fill(content);await page.locator('#sendBtn').click();
  await page.waitForFunction(text=>document.getElementById('kanbanGrid').textContent.includes(text),content);
  assert.equal(fixture.memos[0]?.content,content);assert.equal(fixture.tests.length,0);
  assert.deepEqual(fixture.mutations.map(mutation=>mutation.path),['/api/memos']);
  passed('no installed/logged-in assistant still permits normal recording with no AI request');
  await context.close();
}

async function checkSmallDarkLayout() {
  const { page, context, fixture } = await openPage({theme:'custom',viewport:{width:390,height:844}});
  await assertReadinessOnly(page);
  const geometry = await page.locator('#agentReadinessModal [role="dialog"], #agentReadinessModal[role="dialog"]').evaluate(element=>{
    const r=element.getBoundingClientRect(),style=getComputedStyle(element);
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,overflowY:style.overflowY,background:style.backgroundColor,theme:document.documentElement.getAttribute('data-theme'),title:document.getElementById('agentReadinessTitle').getBoundingClientRect().toJSON(),guide:document.getElementById('readinessGuideOpen').getBoundingClientRect().toJSON()};
  });
  assert.ok(geometry.left>=-1 && geometry.right<=geometry.width+1,'mobile dialog fits horizontally');
  assert.ok(geometry.top>=-1 && geometry.bottom<=geometry.height+1,'mobile dialog fits vertically');
  assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,'mobile dialog content has no horizontal overflow');
  assert.equal(geometry.theme,'custom');
  assert.ok(geometry.guide.left>=geometry.title.right-1 && geometry.guide.top<geometry.title.bottom && geometry.guide.bottom>geometry.title.top,'390px welcome title and guide link stay on the same row');
  assert.equal(geometry.overflowY,'auto');assert.ok(geometry.scrollHeight>geometry.clientHeight,'long mobile welcome content scrolls inside its dialog');
  await page.screenshot({path:path.join(evidence,'readiness-mobile-dark.png')});
  await page.locator('#agentReadinessModal [role="dialog"]').evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await page.screenshot({path:path.join(evidence,'readiness-mobile-dark-bottom.png')});
  await page.locator('#readinessGuideOpen').click();await visible(page,'#guideModal');await visible(page,'#agentReadinessModal',false);
  await page.screenshot({path:path.join(evidence,'introduction-mobile-dark.png')});
  await page.keyboard.press('Escape');await assertReadinessOnly(page);
  await assertFocusedWithin(page,'#agentReadinessModal');
  await page.locator('#agentReadinessOk').focus();await page.keyboard.press('Tab');await assertFocusedWithin(page,'#agentReadinessModal');
  await page.keyboard.press('Shift+Tab');await assertFocusedWithin(page,'#agentReadinessModal');
  await page.locator('#agentReadinessOk').click();
  const helpBounds=await page.locator('#btnHelp').boundingBox(), footerBounds=await page.locator('.app-footer').boundingBox(), copyrightBounds=await page.locator('.app-copyright').boundingBox();
  assert.ok(helpBounds.y>=footerBounds.y-1 && helpBounds.y+helpBounds.height<=footerBounds.y+footerBounds.height+1,'mobile pixel help fits into the footer');
  assert.ok(Math.abs(helpBounds.y+helpBounds.height/2-copyrightBounds.y-copyrightBounds.height/2)<=2,'mobile help and copyright have aligned vertical centers');
  await page.screenshot({path:path.join(evidence,'footer-help-mobile-dark.png')});
  assert.equal(fixture.tests.length,0);
  passed('390px dark-theme dialogs remain within the viewport and support keyboard focus containment',geometry);
  await context.close();
}

async function checkRequestFailuresAndClosing() {
  const { page, context, fixture } = await openPage();
  await assertReadinessOnly(page);
  fixture.failTestRequest=true;
  const fallback = page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ai/readiness' && response.request().method()==='GET');
  await page.locator('[data-test-agent="cc"]').click();
  await fallback;
  await page.locator('#readinessError').getByText('合成测试请求失败',{exact:false}).waitFor();
  assert.equal(await page.locator('[data-test-agent="cc"]').isEnabled(),true,'failed test leaves an explicit retry available');
  fixture.failTestRequest=false;fixture.testDelayMs=250;
  const completed = page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ai/readiness/test');
  await page.locator('[data-test-agent="cc"]').click();
  await page.locator('#agentReadinessOk').click();await visible(page,'#agentReadinessModal',false);
  await completed;
  await page.locator('#btnHelp').click();await assertReadinessOnly(page);
  await page.locator('[data-readiness-agent="cc"]').getByText('连接成功',{exact:false}).first().waitFor();
  assert.equal(fixture.tests.length,2,'slow test response never starts an extra request');
  passed('HTTP test errors remain readable and retryable; closing during a slow test does not reopen a dismissed dialog');
  await context.close();
}

async function checkBasicDetectionRecovery() {
  const { page, context, fixture } = await openPage({checking:true});
  fixture.failReadiness=true;
  await assertReadinessOnly(page);
  await page.locator('#readinessError').getByText('合成检测暂时不可用',{exact:false}).waitFor();
  assert.equal(await page.locator('#readinessRefresh').isEnabled(),true,'a failed poll must not leave the basic-check button locked');
  fixture.failReadiness=false;fixture.readiness.checking=false;
  await page.locator('#readinessRefresh').click();
  await page.waitForFunction(()=>!document.getElementById('readinessRefresh').disabled);
  assert.equal(fixture.refreshes,1);assert.equal(fixture.tests.length,0);
  await page.locator('#agentReadinessOk').click();
  fixture.failReadiness=true;fixture.readiness.serviceId='unreachable-service';
  await load(page);await visible(page,'#guideModal',false);await visible(page,'#agentReadinessModal');
  await page.locator('#readinessError').getByText('合成检测暂时不可用',{exact:false}).waitFor();
  await page.locator('#agentReadinessOk').click();await visible(page,'#agentReadinessModal',false);
  assert.equal(fixture.tests.length,0);
  passed('basic-check network failures stay neutral, remain dismissible, and permit a manual retry without a model request');
  await context.close();
}

async function main() {
  browser = await chromium.launch({headless:true,executablePath:process.env.MEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    await checkIntroAndManualTests();
    await checkNoAIRecords();
    await checkSmallDarkLayout();
    await checkRequestFailuresAndClosing();
    await checkBasicDetectionRecovery();
    assert.deepEqual(report.errors,[],'production page has no uncaught browser errors');
    assert.deepEqual(report.unexpectedRequests,[],'only fixture APIs and local static assets are requested');
    passed('all startup and interaction traffic stayed within the synthetic fixture');
  } catch (error) {
    report.failure=error.stack;
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
    throw error;
  } finally {
    fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
    console.log('Evidence: '+evidence);
    await browser.close();
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
