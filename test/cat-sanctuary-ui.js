// Cat-room browser regression: production pages/assets, synthetic settings only.
// Run: MEMO_PLAYWRIGHT=/path/to/playwright node test/cat-sanctuary-ui.js
// MEMO_CHROME overrides Chrome; no app server, real records or model is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.MEMO_PLAYWRIGHT || 'playwright');
const publicDir = path.join(__dirname, '../public');
const origin = 'http://127.0.0.1:4173';
const evidence = process.env.MEMO_CAT_ROOM_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cat-room-ui-'));
const darkColors = { bg:'#18242D', card:'#243744', accent:'#A3CF90', text:'#E9F4EC', border:'#678277', deco:'#A3CF90' };
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon', '.json':'application/json' };
const report = { checks:[], errors:[], unexpectedRequests:[], fixture:'production cat room; memory-only settings GET/PUT; virtual browser clock; no model or real records' };
let browser, currentPage;
fs.mkdirSync(evidence, { recursive:true });
function passed(name, details = {}) { report.checks.push({ name, ...details });console.log('PASS '+name); }

async function openRoom(width = 1440, height = 1000, theme = 'gold') {
  const fixture = { settings:{ theme, customColors:{...darkColors} }, saves:[] };
  const context = await browser.newContext({ viewport:{ width, height }, deviceScaleFactor:1, acceptDownloads:true });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpectedRequests.push(url.href);return route.abort(); }
    if (url.pathname === '/api/settings') {
      if (request.method() === 'PUT') { const selection=request.postDataJSON();fixture.saves.push(selection);Object.assign(fixture.settings, selection); }
      else if (request.method() !== 'GET') report.unexpectedRequests.push(request.method()+' '+url.pathname);
      return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(fixture.settings) });
    }
    if (url.pathname.startsWith('/api/')) { report.unexpectedRequests.push(request.method()+' '+url.pathname);return route.fulfill({status:400,body:'Unexpected API'}); }
    if (url.pathname === '/favicon.ico') return route.fulfill({status:204,body:''});
    const file = path.resolve(publicDir, '.'+decodeURIComponent(url.pathname));
    if (!file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({status:404,body:'Not found'});
    return route.fulfill({status:200,contentType:mime[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
  });
  const page = await context.newPage();currentPage=page;
  page.on('pageerror', error => report.errors.push({width,message:error.message}));
  await page.clock.install({time:new Date('2026-11-28T02:00:00.000Z')});
  await page.goto(origin+'/cat-sanctuary.html', {waitUntil:'load'});
  await page.evaluate(() => window.CatRoomThemes.ready);
  await page.evaluate(() => document.fonts.ready);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()+50));
  await page.evaluate(() => CatRoomScene.goTo(CatRoomLayout.defaultNode,{instant:true}));
  return {page,context,fixture};
}
const snapshot = page => page.evaluate(() => CatRoomScene.snapshot());
async function advance(page, ms) {
  while (ms > 0) { const step=Math.min(ms,1000);await page.clock.fastForward(step);ms-=step; }
  return snapshot(page);
}
async function settle(page) { await page.clock.runFor(100);await page.waitForTimeout(750); }
const departed = (state, id) => state.nodeId !== id || state.moving && state.destination && state.destination !== id;
async function selectPlace(page, id) {
  await page.locator('#catLocation').selectOption(id);
  const state=await snapshot(page);
  assert.equal(state.destination || state.nodeId,id);assert.equal(state.automatic,true);
  assert.equal(await page.locator('#catLocation').inputValue(),id);
  return state;
}
async function clickCat(page, random = 0) {
  return page.evaluate(random => {
    const original=Math.random;Math.random=()=>random;
    try {document.getElementById('roomCat').click();} finally {Math.random=original;}
    const state=CatRoomScene.snapshot();
    return {...state,duration:CCPixelCat.ANIMATIONS[state.transientAction]?.duration};
  },random);
}
async function setHidden(page, hidden) {
  await page.evaluate(hidden => {
    window.__fixtureHidden=hidden;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__fixtureHidden});
    document.dispatchEvent(new Event('visibilitychange'));
  },hidden);
}

async function checkControlsAndDwell() {
  const {page,context}=await openRoom();
  const controls=await page.evaluate(() => ({
    title:document.querySelector('h1').textContent,tagline:document.querySelector('.tagline').textContent,
    options:[...document.getElementById('catLocation').options].map(o=>({id:o.value,label:o.textContent})),
    nodes:[...CatRoomLayout.nodes].sort((a,b)=>a.number-b.number).map(n=>({id:n.id,label:n.label})),
    numbers:CatRoomLayout.nodes.map(n=>n.number),
    removed:document.querySelectorAll('#catPlaceNote,.cat-place-note,#catAutoToggle,#exploreToggle,#detailNote,#inventoryOpen,#inventoryDialog,#lightToggle,#lightLabel,[data-room-prompt],.quiet-links').length,
    status:{tag:document.getElementById('catAutoStatus').tagName,role:document.getElementById('catAutoStatus').getAttribute('role'),tabindex:document.getElementById('catAutoStatus').getAttribute('tabindex'),text:document.getElementById('catAutoStatus').textContent},
    arrows:['catPrevLocation','catNextLocation'].map(id=>{const e=document.getElementById(id);return {label:e.getAttribute('aria-label'),text:e.textContent.trim()};})
  }));
  assert.equal(controls.title,'猫咪的秘密基地');assert.equal(controls.tagline,'一屋子的喜欢，咪都给你。');
  assert.deepEqual(controls.options,controls.nodes);assert.equal(controls.options.length,12);assert.equal(controls.removed,0);
  assert.equal(new Set(controls.numbers).size,12,'internal place numbers remain stable and unique');
  assert.ok(!['BUTTON','INPUT','SELECT','A'].includes(controls.status.tag));assert.notEqual(controls.status.role,'button');assert.ok(!controls.status.tabindex || Number(controls.status.tabindex)<0);
  assert.match(controls.status.text,/自动/);assert.equal((await snapshot(page)).automatic,true);
  controls.arrows.forEach(arrow=>{assert.ok(arrow.label);assert.ok(arrow.text.length<=2,'arrows must stay icon-only');});
  const ids=controls.nodes.map(n=>n.id);
  await selectPlace(page,ids.at(-1));
  await page.locator('#catNextLocation').click({force:true});assert.equal((await snapshot(page)).destination || (await snapshot(page)).nodeId,ids[0]);
  await page.locator('#catPrevLocation').click({force:true});assert.equal((await snapshot(page)).destination || (await snapshot(page)).nodeId,ids.at(-1));
  for (const id of ids) await selectPlace(page,id);
  passed('location select shows the 12 plain place names; internal numbers stay unique; arrows wrap and manual choices keep auto enabled',controls);
  const dwell=[];
  for (const id of ids) {
    await page.evaluate(id=>CatRoomScene.goTo(id,{instant:true,manual:true}),id);
    const arrival=await snapshot(page);assert.equal(arrival.nodeId,id);assert.equal(arrival.automatic,true);
    const before=await advance(page,9999);assert.equal(departed(before,id),false,'must stay for the full 10 seconds at '+id);
    const after=await advance(page,1);assert.ok(departed(after,id),'must leave at 10 seconds regardless of routine at '+id);
    dwell.push({id,initialState:arrival.state,before:before.state,after:after.nodeId,destination:after.destination,moving:after.moving});
  }
  passed('all 12 places leave at exactly 10 seconds, including finite yarn, sleeping and cycling scratch/house/barrel/hammock routines',{dwell});
  await context.close();
}

async function checkActionsAndVisibility() {
  const {page,context}=await openRoom();
  const observed=new Set();
  await page.evaluate(()=>CatRoomScene.goTo('scratch',{instant:true}));
  for (const random of [0,.5,.99,0,.5,.99]) {const state=await clickCat(page,random);assert.ok(['thinking','error','happy'].includes(state.transientAction));observed.add(state.transientAction);}
  assert.deepEqual([...observed].sort(),['error','happy','thinking']);
  await page.evaluate(()=>CatRoomScene.goTo('scratch',{instant:true}));
  await advance(page,2000);
  const before=await snapshot(page), first=await clickCat(page,0);
  await advance(page,Math.min(1000,first.duration/2));
  assert.equal((await snapshot(page)).behaviorPhase.remainingMs,before.behaviorPhase.remainingMs,'clicking pauses the original phase');
  const replacement=await clickCat(page,.99);assert.notEqual(replacement.transientAction,first.transientAction);
  const restored=await advance(page,replacement.duration);assert.equal(restored.transientAction,null);assert.equal(restored.nodeId,'scratch');
  assert.equal(restored.behaviorPhase.remainingMs,before.behaviorPhase.remainingMs,'repeated clicks retain the original resume context');
  assert.equal(departed(await advance(page,7999),'scratch'),false);
  assert.ok(departed(await advance(page,1),'scratch'),'automatic departure resumes with the original eight seconds remaining');

  await page.evaluate(()=>{CatRoomScene.goTo('yarn',{instant:true});CatRoomScene.goTo('track');});
  await page.clock.runFor(1000);
  const walking=await snapshot(page);assert.equal(walking.moving,true);assert.equal(walking.destination,'track');
  const interrupted=await clickCat(page,0);assert.equal(interrupted.moving,false);
  const resumed=await advance(page,interrupted.duration);assert.equal(resumed.transientAction,null);assert.equal(resumed.moving,true);assert.equal(resumed.destination,'track');
  for(let i=0;i<40 && (await snapshot(page)).moving;i++) await page.clock.runFor(500);
  assert.equal((await snapshot(page)).nodeId,'track');assert.equal((await snapshot(page)).moving,false);
  passed('cat clicks only select thinking/error/happy; repeated actions preserve the routine/dwell deadline and walking resumes to its saved destination',{actions:[...observed],before,restored,walking,resumed});

  await page.evaluate(()=>CatRoomScene.goTo('nest',{instant:true}));
  await advance(page,3500);
  const visible=await snapshot(page);
  await setHidden(page,true);await advance(page,60000);
  assert.equal((await snapshot(page)).nodeId,'nest');assert.equal((await snapshot(page)).behaviorPhase.remainingMs,visible.behaviorPhase.remainingMs);
  await setHidden(page,false);
  assert.equal(departed(await advance(page,6499),'nest'),false);
  assert.ok(departed(await advance(page,1),'nest'),'returning to a hidden page resumes the 6.5-second remaining dwell');
  await page.evaluate(()=>CatRoomScene.goTo('scratch',{instant:true}));
  const action=await clickCat(page,0);await advance(page,action.duration/2);
  await setHidden(page,true);await advance(page,30000);await setHidden(page,false);
  assert.equal((await snapshot(page)).transientAction,action.transientAction);
  const afterHiddenAction=await advance(page,action.duration/2);assert.equal(afterHiddenAction.transientAction,null);
  assert.ok(departed(await advance(page,10000),'scratch'),'a hidden temporary action eventually returns to automatic roaming');
  passed('hidden routines and click actions freeze and resume without consuming background dwell time or becoming stuck');
  await context.close();
}

async function waitForTheme(page,key) {
  for (let i=0;i<200;i++) {
    const state=await page.evaluate(()=>CatRoomThemes.snapshot());
    if (!state.busy && state.theme===key) return state;
    await page.waitForTimeout(25);
  }
  throw new Error('Theme did not settle: '+key);
}
async function themeState(page) {
  return page.evaluate(()=>({
    ...CatRoomThemes.snapshot(),rootTheme:document.documentElement.getAttribute('data-theme'),selected:document.getElementById('roomThemeSelect').value,
    paper:getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),surface:getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
    ink:getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),room:document.getElementById('room').getAttribute('src'),
    download:document.getElementById('downloadScene').getAttribute('href'),downloadName:document.getElementById('downloadScene').download,
    masks:[...document.querySelectorAll('#roomForeground image')].map(e=>e.getAttribute('href'))
  }));
}
async function checkLayout(page,label) {
  const layout=await page.evaluate(()=>({
    viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,
    statusCenter:document.getElementById('catAutoStatus').getBoundingClientRect().x+document.getElementById('catAutoStatus').getBoundingClientRect().width/2,
    actionNotes:document.querySelectorAll('#catPlaceNote,.cat-place-note').length,
    selects:['roomThemeSelect','catLocation'].map(id=>{
      const e=document.getElementById(id),s=getComputedStyle(e),context=document.createElement('canvas').getContext('2d');
      context.font=s.font;const spacing=parseFloat(s.letterSpacing)||0;
      return {id,font:s.font,available:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),options:[...e.options].map(o=>({id:o.value,text:o.textContent,width:context.measureText(o.textContent).width+Math.max(0,o.textContent.length-1)*spacing}))};
    }),
    controls:['roomThemeControls','roomThemeSelect','roomThemePrev','roomThemeNext','stage','catLocation','catPrevLocation','catNextLocation','catAutoStatus','zoomIn','zoomOut','resetView','downloadScene'].map(id=>{
      const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return {id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:s.display,visibility:s.visibility};
    })
  }));
  assert.ok(layout.documentWidth<=layout.viewport[0]+1,label+': no horizontal overflow');
  assert.equal(layout.actionNotes,0,label+': no action description beside the auto status');
  assert.ok(Math.abs(layout.statusCenter-layout.viewport[0]/2)<1,label+': auto status sits alone at the page center');
  for(const e of layout.controls) {
    assert.ok(e.width>0 && e.height>0 && e.display!=='none' && e.visibility!=='hidden',label+': visible '+e.id);
    assert.ok(e.x>=-1 && e.right<=layout.viewport[0]+1,label+': horizontal bounds '+JSON.stringify(e));
    assert.ok(e.y>=-1 && e.bottom<=layout.viewport[1]+1,label+': vertical bounds '+JSON.stringify(e));
  }
  for(const select of layout.selects) for(const option of select.options) assert.ok(option.width<=select.available+.75,label+': selected option text must fit '+JSON.stringify({select:select.id,available:select.available,...option}));
  return layout;
}
async function captureControl(page,selector,name) {
  const box=await page.locator(selector).evaluateAll(elements=>{
    const rects=elements.map(e=>e.getBoundingClientRect()),x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
    return {x,y,width:Math.max(...rects.map(r=>r.right))-x,height:Math.max(...rects.map(r=>r.bottom))-y};
  });
  const viewport=page.viewportSize(),x=Math.max(0,box.x-6),y=Math.max(0,box.y-6);
  const clip={x,y,width:Math.min(viewport.width,box.x+box.width+6)-x,height:Math.min(viewport.height,box.y+box.height+6)-y};
  await page.screenshot({path:path.join(evidence,name),clip});
}

async function focusState(page,id) {
  return page.evaluate(id=>{
    const e=document.getElementById(id),picker=e.closest('.room-theme-picker,.location-picker');
    const style=node=>{const s=getComputedStyle(node);return {outline:s.outlineStyle,outlineWidth:parseFloat(s.outlineWidth),background:s.backgroundColor,border:s.borderColor,appearance:s.appearance};};
    const marker=node=>{const s=getComputedStyle(node,'::after');return {content:s.content,display:s.display,opacity:Number(s.opacity)};};
    return {active:document.activeElement===e,focusVisible:e.matches(':focus-visible'),select:style(e),picker:style(picker),markers:[marker(e),marker(picker)]};
  },id);
}
function assertNoOuterFocus(state,label) {
  for(const key of ['select','picker']) assert.ok(state[key].outline==='none' || state[key].outlineWidth===0,label+': no outside outline on '+key);
  assert.equal(state.select.appearance,'none',label+': no native dropdown arrow');
  state.markers.forEach(marker=>assert.ok(['none','normal'].includes(marker.content) || marker.display==='none' || marker.opacity===0,label+': no dropdown ::after marker'));
}
async function checkFocusAndHitTargets() {
  const {page,context}=await openRoom();
  const results=[];
  for(const [id,previous] of [['roomThemeSelect','roomThemePrev'],['catLocation','catPrevLocation']]) {
    await page.locator('#'+id).click({force:true});await page.keyboard.press('Escape');
    const mouse=await focusState(page,id);assertNoOuterFocus(mouse,id+' mouse');
    await page.locator('#stage').click({position:{x:8,y:8},force:true});
    const blurred=await focusState(page,id);assert.equal(blurred.active,false);assertNoOuterFocus(blurred,id+' blur');
    await page.locator('#'+previous).focus();await page.keyboard.press('Tab');
    const keyboard=await focusState(page,id);assert.equal(keyboard.active,true);assert.equal(keyboard.focusVisible,true);assertNoOuterFocus(keyboard,id+' keyboard');
    await settle(page);
    await captureControl(page,id==='catLocation'?'.control-deck,.cat-activity':'.header-actions',id==='catLocation'?'location-focus.png':'theme-focus.png');
    results.push({id,mouse,blurred,keyboard});
  }
  // These are actual pointer hits, without force, so the decorative layer
  // cannot silently intercept a control or drag gesture.
  await page.locator('#zoomIn').click();assert.equal(await page.locator('#zoomLabel').textContent(),'125%');
  const stage=await page.locator('#stage').boundingBox(),before=await page.locator('#scene').evaluate(e=>e.style.transform);
  await page.mouse.move(stage.x+30,stage.y+30);await page.mouse.down();
  await page.mouse.move(stage.x+65,stage.y+50,{steps:4});await page.mouse.up();
  const after=await page.locator('#scene').evaluate(e=>e.style.transform);assert.notEqual(after,before,'the scene remains draggable through the decorative layer');
  await page.locator('#resetView').click();assert.equal(await page.locator('#zoomLabel').textContent(),'100%');
  passed('mouse click/blur and keyboard select focus keep outlines and dropdown markers absent; real control clicks and scene dragging still work',{results,before,after});
  await context.close();
}

async function particleState(page) {
  return page.evaluate(()=>{
    const layer=document.getElementById('roomParticles'),s=getComputedStyle(layer),r=layer.getBoundingClientRect();
    const items=[...layer.querySelectorAll('.room-particle')].map((e,index)=>{
      const c=getComputedStyle(e),b=e.getBoundingClientRect();
      return {index,paw:e.classList.contains('room-particle--paw'),dust:e.classList.contains('room-particle--dust'),color:c.color,opacity:Number(c.opacity),animation:c.animationName,duration:parseFloat(c.animationDuration),playState:c.animationPlayState,pointerEvents:c.pointerEvents,transform:c.transform,x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};
    });
    return {display:s.display,pointerEvents:s.pointerEvents,ariaHidden:layer.getAttribute('aria-hidden'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:[innerWidth,innerHeight],items};
  });
}
async function capturePaw(page,name) {
  const state=await particleState(page);
  const stage=await page.locator('#stage').boundingBox();
  const candidates=state.items.filter(e=>e.paw && e.opacity>.03 && e.x>=20 && e.y>=20 && e.right<state.viewport[0]-20 && e.bottom<state.viewport[1]-20);
  assert.ok(candidates.length,'at least one naturally animated paw is visible inside the page');
  const outsideStage=e=>e.right<stage.x || e.x>stage.x+stage.width || e.bottom<stage.y || e.y>stage.y+stage.height;
  candidates.sort((a,b)=>Number(outsideStage(b))-Number(outsideStage(a)) || b.opacity*b.width-a.opacity*a.width);
  const paw=candidates[0],padding=22;
  await page.screenshot({path:path.join(evidence,name),clip:{x:paw.x-padding,y:paw.y-padding,width:paw.width+padding*2,height:paw.height+padding*2}});
  return paw;
}
async function checkParticles() {
  const {page,context}=await openRoom();await settle(page);
  const initial=await particleState(page);
  assert.equal(initial.pointerEvents,'none');assert.equal(initial.ariaHidden,'true');
  assert.deepEqual(initial.bounds,{x:0,y:0,width:initial.viewport[0],height:initial.viewport[1]});
  assert.ok(initial.items.some(e=>e.paw));assert.ok(initial.items.some(e=>e.dust));
  initial.items.forEach(e=>{assert.equal(e.pointerEvents,'none');assert.notEqual(e.animation,'none');assert.ok(e.duration>0);});
  await page.waitForTimeout(400);
  const moved=await particleState(page);assert.ok(moved.items.some((e,index)=>e.transform!==initial.items[index].transform),'CSS particles really move with the compositor timeline');
  await capturePaw(page,'paw-detail-gold.png');
  await page.locator('#roomThemeSelect').selectOption('mintchoc');await waitForTheme(page,'mintchoc');await settle(page);
  const themed=await particleState(page);assert.ok(themed.items.some((e,index)=>e.color!==initial.items[index].color),'particle colors automatically follow the selected theme');
  const paw=await capturePaw(page,'paw-detail-mintchoc.png');
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await particleState(page);assert.equal(reduced.display,'none');reduced.items.forEach(e=>assert.equal(e.animation,'none'));
  await page.emulateMedia({reducedMotion:'no-preference'});await settle(page);
  assert.notEqual((await particleState(page)).display,'none');
  passed('full-page CSS paws and dust are visible, animated, non-interactive, theme-colored and hidden for reduced motion',{initial,themed,paw,reducedDisplay:reduced.display});
  await context.close();
}

async function checkThemesZoomAndDownload() {
  const {page,context,fixture}=await openRoom();
  await settle(page);const desktop=await checkLayout(page,'desktop');
  await page.screenshot({path:path.join(evidence,'desktop-gold.png')});
  const themes=[];
  for(const key of ['gold','mintchoc','berry','custom']) {
    await page.locator('#roomThemeSelect').selectOption(key);
    await waitForTheme(page,key);await page.evaluate(()=>CatRoomThemes.whenSaved());
    await settle(page);
    const state=await themeState(page);
    assert.equal(state.rootTheme,key);assert.equal(state.selected,key);assert.equal(state.error,null);
    assert.equal(state.paper,state.palette['--t-bg']);assert.equal(state.surface,state.palette['--t-card']);assert.equal(state.ink,state.palette['--t-text']);
    assert.equal(state.room,state.image);assert.equal(state.download,state.image);state.masks.forEach(src=>assert.equal(src,state.image));
    assert.equal(fixture.settings.theme,key);assert.ok(fixture.saves.some(s=>s.theme===key));
    assert.ok((await snapshot(page)).automatic,'theme changes preserve roaming');
    await checkLayout(page,'desktop '+key);await page.screenshot({path:path.join(evidence,'desktop-'+key+'.png')});
    if(key==='mintchoc') {
      await captureControl(page,'.header-actions','theme-controls-mintchoc.png');
      await captureControl(page,'.control-deck,.cat-activity','controls-mintchoc.png');
    }
    themes.push(state);
  }
  await page.locator('#zoomIn').click({force:true});assert.equal(await page.locator('#zoomLabel').textContent(),'125%');
  await page.locator('#zoomIn').click({force:true});assert.equal(await page.locator('#zoomLabel').textContent(),'150%');
  await page.locator('#zoomOut').click({force:true});assert.equal(await page.locator('#zoomLabel').textContent(),'125%');
  await page.locator('#resetView').click({force:true});assert.equal(await page.locator('#zoomLabel').textContent(),'100%');
  assert.equal(await page.locator('#zoomOut').isDisabled(),true);
  const footer=await page.locator('.footer').boundingBox();
  await page.screenshot({path:path.join(evidence,'controls-detail.png'),clip:footer});
  passed('gold/mintchoc/berry/custom dark themes keep room, cat/UI palette, foreground masks and saved settings synchronized',{themes});
  passed('desktop controls fit and zoom/reset still work',{desktop});
  await context.close();
  for(const [width,height] of [[320,780],[390,844]]) {
    const mobile=await openRoom(width,height,'mintchoc');await settle(mobile.page);
    const layout=await checkLayout(mobile.page,'mobile '+width);
    const longest=[...layout.selects.find(s=>s.id==='catLocation').options].sort((a,b)=>b.width-a.width)[0];
    await selectPlace(mobile.page,longest.id);await settle(mobile.page);
    await mobile.page.screenshot({path:path.join(evidence,'mobile-'+width+'.png')});
    await selectPlace(mobile.page,'high-perch');await mobile.page.locator('#catNextLocation').click({force:true});
    assert.equal((await snapshot(mobile.page)).automatic,true);
    passed(width+'px mobile controls are visible without horizontal/vertical overflow and remain interactive',{layout});
    await mobile.context.close();
  }
}

async function checkActualDownload() {
  // Chromium's browser-process download bypasses route.fulfill in this setup.
  // Use a separate ephemeral server serving only public assets and memory-only
  // settings, rather than the application server or any real data directory.
  const settings={theme:'mintchoc',customColors:{...darkColors}};
  const server=http.createServer(async (request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    if(url.pathname==='/api/settings') {
      if(request.method==='PUT') {let body='';for await(const chunk of request)body+=chunk;Object.assign(settings,JSON.parse(body));}
      else assert.equal(request.method,'GET');
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(settings));return;
    }
    const file=path.resolve(publicDir,'.'+decodeURIComponent(url.pathname));
    if(request.method!=='GET' || !file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});response.end(fs.readFileSync(file));
  });
  let context;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    context=await browser.newContext({viewport:{width:1100,height:900},acceptDownloads:true});
    const page=await context.newPage();currentPage=page;
    page.on('pageerror',error=>report.errors.push({fixture:'download',message:error.message}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/cat-sanctuary.html',{waitUntil:'load'});
    await page.evaluate(()=>CatRoomThemes.ready);
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#downloadScene').click()]);
    assert.equal(await download.failure(),null);assert.match(download.suggestedFilename(),/猫咪的秘密基地.*\.png$/);
    const downloadPath=path.join(evidence,'saved-room.png');await download.saveAs(downloadPath);
    const saved=fs.readFileSync(downloadPath);assert.ok(saved.length>10000);assert.equal(saved.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    passed('the unmodified save-picture link downloads a valid themed PNG over real isolated loopback HTTP',{filename:download.suggestedFilename(),bytes:saved.length});
  } finally {
    if(context)await context.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

async function checkDirectFile() {
  const context=await browser.newContext({viewport:{width:1100,height:900}});
  await context.route(/^https?:\/\//,route=>{report.unexpectedRequests.push('file page network: '+route.request().url());return route.abort();});
  try {
    const page=await context.newPage();currentPage=page;
    page.on('pageerror',error=>report.errors.push({fixture:'file',message:error.message}));
    await page.goto(pathToFileURL(path.join(publicDir,'cat-sanctuary.html')).href,{waitUntil:'load'});
    await page.evaluate(()=>CatRoomThemes.ready);await page.evaluate(()=>document.fonts.ready);
    const initial=await page.evaluate(()=>({scene:CatRoomScene.snapshot(),particles:RoomParticles.snapshot(),image:document.getElementById('room').naturalWidth}));
    assert.equal(initial.image,1254);assert.equal(initial.scene.automatic,true);assert.equal(initial.particles.mounted,true);assert.ok(initial.particles.paws>0);
    await page.locator('#roomThemeSelect').selectOption('mintchoc');await waitForTheme(page,'mintchoc');
    await page.waitForTimeout(750);
    assert.equal((await themeState(page)).rootTheme,'mintchoc');assertNoOuterFocus(await focusState(page,'roomThemeSelect'),'file dropdown');
    await page.screenshot({path:path.join(evidence,'file-open-mintchoc.png')});
    passed('direct file:// opening loads room, cat, particles and theme switching without any HTTP API or network request',{initial});
  } finally {await context.close();}
}

(async()=>{
  try {
    browser=await chromium.launch({executablePath:process.env.MEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    await checkControlsAndDwell();await checkActionsAndVisibility();await checkFocusAndHitTargets();await checkParticles();await checkThemesZoomAndDownload();await checkActualDownload();await checkDirectFile();
    assert.deepEqual(report.errors,[],'production room must not throw renderer errors');
    assert.deepEqual(report.unexpectedRequests,[],'all state stays inside the synthetic fixture');
  } catch(error) {
    report.failure=error.stack || String(error);console.error(error);process.exitCode=1;
    if(currentPage && !currentPage.isClosed()) await currentPage.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  } finally {
    console.log('Cat-room evidence: '+evidence);
    fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));if(browser)await browser.close();
  }
})();
