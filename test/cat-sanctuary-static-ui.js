// Standalone cat-room package regression, with a real static-only HTTP server.
// Build first, then run: MEMO_PLAYWRIGHT=/path/to/playwright node test/cat-sanctuary-static-ui.js
// MEMO_CAT_STATIC_DIR overrides output/cat-sanctuary-site; no API/data/model is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.MEMO_PLAYWRIGHT || 'playwright');
const staticDir = path.resolve(process.env.MEMO_CAT_STATIC_DIR || path.join(__dirname,'../output/cat-sanctuary-site'));
const sourcePublic = path.join(__dirname,'../public');
const evidence = process.env.MEMO_CAT_STATIC_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(),'memo-cat-static-ui-'));
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.png':'image/png', '.webp':'image/webp', '.json':'application/json', '.txt':'text/plain; charset=utf-8' };
const report = { checks:[], errors:[], requests:[], apiRequests:[], externalRequests:[], fixture:'built standalone package, static-only ephemeral loopback HTTP, no backend/API/data/model' };
let browser, server, currentPage, origin;
fs.mkdirSync(evidence,{recursive:true});
function passed(name,details={}) { report.checks.push({name,...details});console.log('PASS '+name); }

function inspectPackage() {
  assert.ok(fs.statSync(staticDir).isDirectory(),'build the standalone package before running this test');
  const files=[];
  function walk(directory,relative='') {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const name=entry.name,relativePath=path.join(relative,name),file=path.join(directory,name);
      assert.equal(entry.isSymbolicLink(),false,'the standalone package must contain actual files rather than external symlinks');
      assert.ok(!/^(?:\.git|\.agents|\.codex|\.aws|\.ssh|node_modules|data|storage|tasks|agents)$/i.test(name),'the package must exclude journal backend, data and private configuration directories');
      assert.ok(!/^(?:\.deploy.*|\.env(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?|authorized_keys)$/i.test(name) && !/\.(?:key|pem|p12|pfx|pub)$/i.test(name),'the package must exclude deployment keys and credentials');
      assert.ok(!/^(?:server\.js|electron-main\.js|electron-preload\.js|package(?:-lock)?\.json|memos\.json|settings\.json|suggestions\.json|latest-ai-task\.json)$/i.test(name) && !/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(name),'the package must exclude journal backend and stored records');
      if(entry.isDirectory()) walk(file,relativePath);
      else {
        const size=fs.statSync(file).size;files.push({path:relativePath,size});
        if(/\.(?:html|js|css|json|txt|md|svg)$/i.test(name)) assert.ok(!/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(fs.readFileSync(file,'utf8')),'the package must not contain private-key material');
      }
    }
  }
  walk(staticDir);
  for(const entry of ['index.html','cat-sanctuary.html','favicon.svg','favicon.ico']) assert.ok(files.some(file=>file.path===entry),'missing required standalone entry or favicon: '+entry);
  passed('standalone package contains both entries and favicons, with no deployment keys, backend, dependencies or user data',{files:files.length,bytes:files.reduce((total,file)=>total+file.size,0)});
}

async function startStaticServer() {
  server=http.createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1'),record={method:request.method,path:url.pathname,status:0};
    report.requests.push(record);
    if(url.pathname.startsWith('/api/')) {report.apiRequests.push({method:request.method,path:url.pathname});record.status=404;response.writeHead(404);response.end('Static site: no API');return;}
    if(!['GET','HEAD'].includes(request.method)) {record.status=405;response.writeHead(405);response.end();return;}
    const file=path.resolve(staticDir,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!file.startsWith(staticDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {record.status=404;response.writeHead(404);response.end('Not found');return;}
    record.status=200;response.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store'});
    if(request.method==='HEAD') response.end();else fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
}
async function ready(page) {
  await page.evaluate(()=>CatRoomThemes.ready);
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('#roomCat canvas');
    return document.getElementById('room').naturalWidth>0 && canvas && canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4===3 && value>0);
  });
}
async function waitForTheme(page,key) {
  for(let i=0;i<200;i++) {
    const state=await page.evaluate(()=>CatRoomThemes.snapshot());
    if(!state.busy && state.theme===key) return state;
    await page.waitForTimeout(25);
  }
  throw new Error('The packaged theme did not load: '+key);
}
async function assertNoApiOrSaveFailure(page) {
  await page.evaluate(async()=>{
    await CatRoomThemes.whenSaved();
    window.dispatchEvent(new Event('focus'));
    Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(100);
  const status=await page.locator('#roomThemeStatus').textContent();
  assert.ok(!/未能保存|保存失败|无法保存|下次打开时可能恢复/.test(status),'local mode must not announce an API save failure');
  assert.equal(await page.locator('#roomThemeStatus').evaluate(e=>e.classList.contains('room-theme-error')),false);
  assert.deepEqual(report.apiRequests,[],'theme changes, focus and visibility must never request /api in the standalone build');
}

async function checkEntryAndThemes(page,context) {
  await page.goto(origin+'/',{waitUntil:'load'});await ready(page);
  const initial=await page.evaluate(()=>{
    const canvas=document.querySelector('#roomCat canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    return {title:document.title,heading:document.querySelector('h1').textContent,local:document.documentElement.dataset.roomSettings,scene:CatRoomScene.snapshot(),themes:CatSanctuaryThemeCatalog.themes.map(({key,name,image})=>({key,name,image})),options:[...document.getElementById('roomThemeSelect').options].filter(option=>!option.disabled && option.value!=='custom').map(option=>option.value),catPainted:pixels.some((value,index)=>index%4===3 && value>0)};
  });
  assert.equal(initial.title,'猫咪的秘密基地');assert.equal(initial.heading,'猫咪的秘密基地');assert.equal(initial.local,'local');assert.equal(initial.catPainted,true);
  assert.equal(initial.themes.length,24);assert.equal(new Set(initial.options).size,24);assert.deepEqual(initial.options,initial.themes.map(theme=>theme.key));
  const assets=[];
  for(const theme of initial.themes) {
    const response=await context.request.head(new URL(theme.image,origin+'/').href);assert.equal(response.status(),200,'theme asset is reachable: '+theme.key);
    const asset=path.resolve(staticDir,theme.image);assert.ok(asset.startsWith(staticDir+path.sep));
    const header=Buffer.alloc(24),fd=fs.openSync(asset,'r');try {fs.readSync(fd,header,0,24,0);} finally {fs.closeSync(fd);}
    assert.equal(header.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(header.readUInt32BE(16),initial.scene.source.width);assert.equal(header.readUInt32BE(20),initial.scene.source.height);
    assets.push({theme:theme.key,status:response.status(),width:header.readUInt32BE(16),height:header.readUInt32BE(20)});
  }
  passed('root entry loads the real cat and all 24 packaged theme images',{initial,assets});
  const switched=[];
  for(const key of ['gold','mintchoc','berry']) {
    await page.locator('#roomThemeSelect').selectOption(key);const state=await waitForTheme(page,key);
    await assertNoApiOrSaveFailure(page);
    const rendered=await page.evaluate(()=>({theme:document.documentElement.getAttribute('data-theme'),selected:document.getElementById('roomThemeSelect').value,loaded:document.getElementById('room').complete && document.getElementById('room').naturalWidth>0,image:document.getElementById('room').getAttribute('src'),saved:MemoThemeSync.read()}));
    assert.equal(rendered.theme,key);assert.equal(rendered.selected,key);assert.equal(rendered.loaded,true);assert.equal(rendered.image,state.image);assert.equal(rendered.saved.theme,key);
    await page.waitForTimeout(400);await page.screenshot({path:path.join(evidence,'standalone-'+key+'.png')});
    switched.push(rendered);
  }
  // Remove the preview query so a reload must use persisted local storage.
  await page.evaluate(()=>history.replaceState(history.state,'','/'));
  await page.reload({waitUntil:'load'});await ready(page);
  assert.equal(await page.locator('#roomThemeSelect').inputValue(),'berry');
  assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-theme')),'berry');
  await assertNoApiOrSaveFailure(page);
  passed('gold/mintchoc/berry switch without APIs or save errors; a query-free reload restores the locally saved theme',{switched});
  await page.goto(origin+'/cat-sanctuary.html',{waitUntil:'load'});await ready(page);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.roomSettings),'local');
  assert.equal(await page.locator('#roomThemeSelect').inputValue(),'berry');
  await assertNoApiOrSaveFailure(page);
  passed('the cat-sanctuary.html compatibility entry also runs in local mode and shares the saved theme');
}

async function checkFavicons(page,context) {
  const links=await page.evaluate(()=>[...document.querySelectorAll('link[rel="icon"]')].map(e=>({href:e.href,type:e.type})));
  const checked=[];
  for(const name of ['favicon.svg','favicon.ico']) {
    const link=links.find(link=>new URL(link.href).pathname==='/'+name);assert.ok(link,'standalone HTML must link '+name);
    const response=await context.request.get(link.href);assert.equal(response.status(),200);
    const body=await response.body(),packaged=fs.readFileSync(path.join(staticDir,name)),mainIcon=fs.readFileSync(path.join(sourcePublic,name));
    assert.equal(body.equals(packaged),true,'HTTP serves the packaged favicon bytes');assert.equal(body.equals(mainIcon),true,'standalone favicon matches the journal icon');
    if(name.endsWith('.svg')) {assert.match(response.headers()['content-type'],/image\/svg\+xml/);assert.match(body.toString('utf8'),/<svg[\s>]/);}
    else {assert.equal(body.subarray(0,4).toString('hex'),'00000100');assert.ok(body.readUInt16LE(4)>0);}
    checked.push({name,status:response.status(),bytes:body.length,type:response.headers()['content-type']});
  }
  passed('both favicon links return HTTP 200 with valid bytes matching the main-page icons',{checked});
}

(async()=>{
  try {
    inspectPackage();await startStaticServer();
    browser=await chromium.launch({executablePath:process.env.MEMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
    await context.route(/^https?:\/\//,route=>{if(new URL(route.request().url()).origin===origin)return route.continue();report.externalRequests.push(route.request().url());return route.abort();});
    const page=await context.newPage();currentPage=page;page.on('pageerror',error=>report.errors.push(error.message));
    await checkEntryAndThemes(page,context);await checkFavicons(page,context);
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.apiRequests,[]);assert.deepEqual(report.externalRequests,[]);
    assert.deepEqual(report.requests.filter(request=>request.status>=400),[],'all requested standalone assets must exist');
    await context.close();
  } catch(error) {
    report.failure=error.stack || String(error);console.error(error);process.exitCode=1;
    if(currentPage && !currentPage.isClosed()) await currentPage.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  } finally {
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log('Static cat-room evidence: '+evidence);
  }
})();
