const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wish-ui-'));
const profile = path.join(root, 'profile');fs.mkdirSync(profile);
app.setPath('userData', profile);app.disableHardwareAcceleration();
let child, window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression) {
  for (let i = 0; i < 400; i++) { if (await window.webContents.executeJavaScript(expression)) return;await delay(25); }
  throw new Error('UI wait failed: ' + expression);
}
async function run() {
  const dataDir = path.join(root, 'data');fs.mkdirSync(dataDir);
  const data = require('../storage/defaults')();data['habit_pools.json'].pools = [];
  for (const [file, value] of Object.entries(data)) fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value));
  const node = process.env.MEMO_TEST_NODE || process.execPath;
  const fake = path.join(root, 'fake-claude'), quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(fake, `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(__dirname, 'fake-model-cli.js'))} "$@"\n`, { mode: 0o755 });
  const mode = path.join(root, 'mode'), capture = path.join(root, 'calls.jsonl');fs.writeFileSync(mode, 'stream-slow');
  const probe = net.createServer();probe.listen(0, '127.0.0.1');await once(probe, 'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  child = spawn(node, [path.join(__dirname, '../server.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MEMO_ELECTRON: '1', MEMO_DATA_DIR: dataDir, MEMO_CONFIG_DIR: root, PORT: String(port), CLAUDE_CLI: fake, MEMO_FAKE_CC_INVALID_FILE: mode, MEMO_FAKE_CC_CAPTURE: capture }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';child.stderr.on('data', chunk => { logs += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 10000);
    child.stdout.on('data', chunk => { logs += chunk;if (logs.includes('Memo server running')) { clearTimeout(timer);resolve(); } });
    child.once('exit', code => { clearTimeout(timer);reject(new Error('Startup ' + code + ': ' + logs)); });
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith(`http://127.0.0.1:${port}/`) }));
  await window.loadURL(`http://127.0.0.1:${port}`);
  await until('agentStatusKnown && aiState.configured');
  await window.webContents.executeJavaScript(`
    document.getElementById('btnHabitTrack').click();
    if(document.getElementById('habitUploadArea').classList.contains('hidden'))throw new Error('Book entry disappeared');
    if(document.getElementById('habitPanelPools').contains(document.getElementById('habitWishWizard')))throw new Error('Conversation is still inline');
    if(document.querySelector('.habit-upload-hint'))throw new Error('Old external upload guide remains');
    for(const ext of ['.txt','.zip','.doc','.docx','.pdf'])if(!document.getElementById('habitFileInput').accept.includes(ext))throw new Error('Missing material '+ext);
    document.getElementById('habitWishStart').click();
    if(!document.querySelector('#tagSummaryModal > .modal-content').inert)throw new Error('Parent should be inert under child dialog');
    if(document.activeElement.id!=='habitWishInput')throw new Error('Child input did not receive focus');
    document.getElementById('habitWishInput').value='我想开始画画';
    document.getElementById('habitWishForm').requestSubmit();
  `);
  await until('document.querySelector("#habitWishMessages [data-current]")?.textContent.includes("关于")');
  if(await window.webContents.executeJavaScript(`document.getElementById('habitWishWizard').classList.contains('hidden')`))throw new Error('Question stage should stay open');
  const lengths = [];
  for (let i = 0; i < 150; i++) {
    const sample = await window.webContents.executeJavaScript('({text:document.querySelector("#habitWishMessages [data-current]")?.textContent || "",pending:document.getElementById("habitWishStatus").classList.contains("is-pending"),options:document.querySelectorAll(".habit-wish-option").length})');
    if (!sample.pending) break;
    if (sample.options) throw new Error('Options became clickable while question was incomplete');
    if (sample.text.length && sample.text.length !== lengths.at(-1)) lengths.push(sample.text.length);
    await delay(30);
  }
  if (lengths.length < 3) throw new Error('Question did not visibly stream: ' + JSON.stringify(lengths));
  await window.webContents.executeJavaScript(`
    var current=document.querySelector('#habitWishMessages [data-current]').textContent;
    document.getElementById('habitWishHide').click();document.getElementById('habitWishStart').click();
    if(document.querySelector('#habitWishMessages [data-current]').textContent!==current)throw new Error('Collapsing lost the stream');
    document.getElementById('tagSummaryClose').click();
    if(!document.getElementById('habitWishWizard').classList.contains('hidden') || document.querySelector('#tagSummaryModal > .modal-content').inert)throw new Error('Closing parent did not dismiss child');
    document.getElementById('btnHabitTrack').click();document.getElementById('habitWishStart').click();
    if(!document.getElementById('habitWishMessages').textContent.includes('我想开始画画'))throw new Error('Reopening lost the wish');
  `);
  await until('document.querySelectorAll(".habit-wish-option").length===4');
  await delay(180);
  const out = process.env.MEMO_UI_SCREENSHOT_DIR;
  if (out) { fs.mkdirSync(out, { recursive: true });fs.writeFileSync(path.join(out, 'wish-options.png'), (await window.webContents.capturePage()).toPNG()); }
  window.setSize(390, 820);await delay(150);
  await window.webContents.executeJavaScript(`
    var panel=document.getElementById('habitPanelPools');
    if(panel.scrollWidth>panel.clientWidth+2)throw new Error('Narrow layout overflows');
    var child=document.querySelector('#habitWishWizard [role="dialog"]'),rect=child.getBoundingClientRect();
    if(rect.left<0 || rect.right>innerWidth || rect.top<0 || rect.bottom>innerHeight)throw new Error('Child dialog exceeds viewport');
    document.getElementById('habitWishRestart').focus();
    document.getElementById('habitWishRestart').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    if(document.activeElement.id!=='habitWishHide')throw new Error('Focus escaped second-level dialog');
    document.querySelectorAll('.habit-wish-option')[3].click();
    if(document.getElementById('habitWishForm').classList.contains('hidden'))throw new Error('Other did not open input');
    document.getElementById('habitWishInput').value='想和朋友一起享受画画';
    document.getElementById('habitWishInput').focus();
    document.getElementById('habitWishForm').requestSubmit();
    if(!document.querySelector('#habitWishWizard [role="dialog"]').contains(document.activeElement))throw new Error('Answer rendering lost dialog focus');
  `);
  await until('document.querySelectorAll(".habit-wish-option").length===4 && document.getElementById("habitWishStep").textContent.startsWith("3 / 3")');
  await delay(180);
  if (out) fs.writeFileSync(path.join(out, 'wish-mobile.png'), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(mode, 'duplicate:habit-wish-pool');
  await window.webContents.executeJavaScript(`
    if(!document.querySelector('#habitWishMessages [data-current]').textContent.includes('朋友'))throw new Error('Purpose was not used');
    document.querySelectorAll('.habit-wish-option')[3].click();
    document.getElementById('habitWishInput').value='每天五分钟，轻松一点';
    document.getElementById('habitWishForm').requestSubmit();
  `);
  await until('document.getElementById("habitWishWizard").classList.contains("hidden") && document.getElementById("habitWishProgress").classList.contains("is-generating")');
  await window.webContents.executeJavaScript(`
    if(document.getElementById('tagSummaryModal').classList.contains('hidden'))throw new Error('Parent incorrectly closed with generation');
    if(document.querySelector('#tagSummaryModal > .modal-content').inert)throw new Error('Parent remains inert after automatic shrink');
    if(!document.getElementById('habitWishProgressTitle').textContent.includes('正在生成习惯卡池'))throw new Error('No generation state in parent');
  `);
  if(out)fs.writeFileSync(path.join(out,'wish-generating-collapsed.png'),(await window.webContents.capturePage()).toPNG());
  await until('!document.getElementById("habitWishError").classList.contains("hidden")');
  await window.webContents.executeJavaScript(`
    if(!document.getElementById('habitWishProgress').classList.contains('is-error'))throw new Error('Collapsed error was not surfaced');
    document.getElementById('habitWishResume').click();
    if(habitPools.length)throw new Error('Invalid cards were saved');
    if(document.querySelectorAll('#habitWishMessages .user').length!==3)throw new Error('Answers were lost');
    if(/JSON|PRIVATE_THINKING|options|question/.test(document.getElementById('habitWishWizard').textContent))throw new Error('Internal output leaked');
  `);
  fs.rmSync(mode);
  await window.webContents.executeJavaScript(`document.getElementById('habitWishRetry').click()`);
  await until('!document.getElementById("habitWishSuccess").classList.contains("hidden")');
  await window.webContents.executeJavaScript(`
    if(!document.getElementById('habitWishWizard').classList.contains('hidden'))throw new Error('Retry did not shrink automatically');
    if(habitPools.length!==1 || habitPools[0].habits.length!==30)throw new Error('Wrong pool count');
    if(habitPools[0].wishContext.purpose!=='想和朋友一起享受画画' || habitPools[0].wishContext.effort!=='每天五分钟，轻松一点')throw new Error('Custom answers not saved');
    window.firstWishPoolId=habitPools[0].id;
    window.firstWishConversation=document.getElementById('habitWishMessages').textContent;
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('An unviewed completion needs a reachable entry');
    document.getElementById('tagSummaryClose').click();document.getElementById('btnHabitTrack').click();
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Unviewed completion disappeared on reopen');
  `);
  const otherResponse=await fetch(`http://127.0.0.1:${port}/api/habit/pools/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'另一份独立素材：观察窗外光线，阅读一页，写下新的发现。'})});
  const otherResult=await otherResponse.json();
  if(!otherResponse.ok || !otherResult.pool)throw new Error('Other-pool fixture failed: '+JSON.stringify(otherResult));
  await window.webContents.executeJavaScript(`(async()=>{
    await loadHabitPools();
    showHabitPoolDetail(${JSON.stringify(otherResult.pool.id)});
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Opening a different pool cleared the completion');
    document.getElementById('habitPoolDetailClose').click();
    showHabitPoolDetail('missing-pool-id');
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('A missing pool cleared the completion');
    document.getElementById('habitWishResume').click();
    if(document.querySelectorAll('.habit-pool-detail-item').length!==30)throw new Error('Pool detail integration failed');
    if(document.getElementById('habitPoolDetailModal').classList.contains('hidden') || habitDetailPoolId!==window.firstWishPoolId)throw new Error('The requested wish pool did not actually open');
    if(!document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Viewed completion stayed in the parent');
    if(!document.getElementById('habitWishSuccess').classList.contains('hidden'))throw new Error('Viewed completion stayed in the conversation');
    if(document.getElementById('habitWishMessages').textContent!==window.firstWishConversation)throw new Error('Marking viewed erased the conversation');
    document.getElementById('habitPoolDetailClose').click();
    document.getElementById('tagSummaryClose').click();document.getElementById('btnHabitTrack').click();
    if(!document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Viewed completion reappeared on reopen');
    window.habitWishDialog.open();
    if(!document.getElementById('habitWishSuccess').classList.contains('hidden'))throw new Error('Viewed conversation repeated the success prompt');
    if(document.getElementById('habitWishMessages').textContent!==window.firstWishConversation)throw new Error('Reopened history lost the answers');
    if(document.getElementById('habitWishRestart').disabled)throw new Error('Viewed conversation cannot start another plan');
    window.habitWishDialog.close();
  })()`);
  window.setSize(1100, 900);await delay(150);
  if (out) fs.writeFileSync(path.join(out, 'wish-success.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    document.getElementById('habitWishStart').click();
    document.getElementById('habitWishHide').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if(!document.getElementById('habitWishWizard').classList.contains('hidden'))throw new Error('Escape did not close child');
    if(document.activeElement.id!=='habitWishStart')throw new Error('Focus did not return to entry');
    document.getElementById('habitWishStart').click();document.getElementById('habitWishWizard').click();
    if(document.querySelector('#tagSummaryModal > .modal-content').inert)throw new Error('Backdrop left parent inert');
    document.getElementById('habitWishStart').click();document.getElementById('habitWishRestart').click();
    document.getElementById('habitWishInput').value='再练习一项小习惯';document.getElementById('habitWishForm').requestSubmit();
  `);
  await until('document.querySelectorAll(".habit-wish-option").length===4');
  const optionPoint=await window.webContents.executeJavaScript(`(()=>{const rect=document.querySelector('.habit-wish-option').getBoundingClientRect();return {x:Math.round(rect.left+20),y:Math.round(rect.top+20)}})()`);
  window.webContents.sendInputEvent({type:'mouseDown',...optionPoint,button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseUp',...optionPoint,button:'left',clickCount:1});
  await until(`document.getElementById('habitWishStep').textContent.startsWith('3 / 3')`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await delay(100);
  if(!await window.webContents.executeJavaScript(`document.querySelector('#habitWishWizard [role="dialog"]').contains(document.activeElement)`))throw new Error('Natural answer click then Tab escaped the child dialog');
  await until('document.querySelectorAll(".habit-wish-option").length===4');
  await window.webContents.executeJavaScript(`document.querySelector('.habit-wish-option').click()`);
  await until(`habitPools.length===3 && document.getElementById('habitWishProgress').classList.contains('is-complete')`);
  await window.webContents.executeJavaScript(`
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('A new generation did not create a new completion notice');
    if(document.getElementById('habitWishSuccess').classList.contains('hidden'))throw new Error('New conversation success did not reset its viewed state');
    var newPool=habitPools.find(pool=>pool.sourceType==='wish' && pool.id!==window.firstWishPoolId);
    if(!newPool || newPool.habits.length!==30)throw new Error('New plan was not automatically saved');
    var resultCTA=document.querySelector('#habitUploadProgress + [data-ai-task-details]');
    var completedBubble=document.getElementById('ccTaskBubble');
    if(!resultCTA || resultCTA.hidden || resultCTA.disabled)throw new Error('The new pool needs a reachable result navigation entry');
    if(completedBubble.classList.contains('hidden') || !completedBubble.querySelector('[data-ai-task-details]:not([hidden])'))throw new Error('The new pool completion bubble was not reachable');
    showHabitPoolDetail(window.firstWishPoolId);
    if(document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Viewing an older wish cleared the newer completion');
    if(resultCTA.hidden || completedBubble.classList.contains('hidden'))throw new Error('Viewing an older pool cleared the newer task navigation entry');
    document.getElementById('habitPoolDetailClose').click();
    var beforeViewedCatState=window._ccActivity.getState();
    document.querySelector('.habit-pool-card[data-id="'+newPool.id+'"] .habit-pool-info').click();
    if(document.getElementById('habitPoolDetailModal').classList.contains('hidden') || habitDetailPoolId!==newPool.id)throw new Error('The newly generated pool did not actually open');
    if(!document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Opening the generated pool from the pool list did not mark it viewed');
    if(!resultCTA.hidden)throw new Error('Viewed pool left its ordinary inline navigation entry visible');
    if(!completedBubble.classList.contains('hidden'))throw new Error('Viewed pool left its completed navigation bubble visible');
    if(window._ccActivity.getState()!==beforeViewedCatState)throw new Error('Clearing viewed navigation changed the cat feedback state');
    document.getElementById('habitPoolDetailClose').click();
    document.getElementById('tagSummaryClose').click();document.getElementById('btnHabitTrack').click();
  `);
  await delay(2600);
  await window.webContents.executeJavaScript(`
    if(!document.querySelector('#habitUploadProgress + [data-ai-task-details]').hidden)throw new Error('Polling revived the viewed pool navigation entry');
    if(!document.getElementById('habitWishProgress').classList.contains('hidden'))throw new Error('Reopening revived the viewed completion banner');
  `);
  if(out)fs.writeFileSync(path.join(out,'wish-viewed-clean.png'),(await window.webContents.capturePage()).toPNG());
  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  if (calls.filter(call => call.task === 'habit-wish-question').length !== 4) throw new Error('Unexpected extra questions');
  console.log(JSON.stringify({ visibleStreamLengths: lengths, twoGuidedQuestions: true, fourOptions: true, customAnswers: true, collapseAndReopen: true, naturalOptionClickFocus: true, narrowLayout: true, invalidResultsRejected: true, retry: true, automaticSave: true, unviewedNoticeRetained: true, onlyMatchingPoolMarksViewed: true, viewedNoticeStaysHiddenOnReopen: true, conversationRetained: true, nextGenerationHasFreshNotice: true, viewedPoolCtaHidden: true, olderPoolKeepsNewCta: true, completedBubbleClosed: true, catFeedbackUnchanged: true, savedWishPools: 2, savedCardsPerPool: 30 }));
}
app.whenReady().then(run).catch(error => { console.error(error.stack);process.exitCode = 1; }).finally(async () => {
  window?.destroy();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM');await once(child, 'close'); }
  fs.rmSync(root, { recursive: true, force: true });app.exit(process.exitCode || 0);
});
