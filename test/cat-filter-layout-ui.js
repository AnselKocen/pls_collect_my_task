// Real Chromium layout/clock regression. APIs are synthetic and stay in memory.
// Run with Node; MEMO_PLAYWRIGHT and MEMO_CHROME may override local runtime paths.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.MEMO_PLAYWRIGHT || 'playwright');
const publicDir=path.join(__dirname,'../public');
const out=process.env.MEMO_CAT_FILTER_EVIDENCE || path.join(__dirname,'cat-filter-fix-evidence');
const origin='http://memo-filter-fixture.test';
const counts={mark:7,'待办':8,'脑洞':2,'链接':10,'杂乱':0,'账号':5,'备份':2,tips:3,'思考':3,'指南':1,'欢迎':1,'功能':0,'特色玩法':1,cc:1};
const tags=Object.keys(counts),now=new Date().toISOString();
const settings={...require('../storage/defaults')()['settings.json'],theme:'mintchoc',tags,tagOrder:tags};
const memos=tags.flatMap(tag=>Array.from({length:counts[tag]},(_,i)=>({id:tag+'-'+i,content:tag+' 的第 '+(i+1)+' 条合成记录。',tags:[tag],createdAt:now,updatedAt:now})));
const report={fixture:{counts,memos:memos.length,model:'no model calls; all APIs in memory'},runs:[],errors:[],consoleErrors:[],unexpectedRequests:[],startedAt:new Date().toISOString()};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
let browser,currentPage,currentName='startup';
fs.mkdirSync(out,{recursive:true});

function caseData(longLabels){
  if(!longLabels)return {tags,settings,memos};
  const names=tags.map(tag=>tag==='待办'?'这是一个很长的中文待办标签名字用来验证窄屏省略和猫咪空间':tag==='特色玩法'?'这里还有一个非常长的中文扩展标签验证展开以后不会侵入猫咪区域':tag);
  return {tags:names,settings:{...settings,tags:names,tagOrder:names},memos:names.flatMap((tag,index)=>Array.from({length:counts[tags[index]]},(_,i)=>({id:tag+'-'+i,content:tag+' 的第 '+(i+1)+' 条合成记录。',tags:[tag],createdAt:now,updatedAt:now})))};
}

async function installRoutes(context,data){
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){
      // The graph/Markdown CDN scripts are unused by this filter test.
      return route.fulfill({status:200,contentType:'application/javascript',body:''});
    }
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.startsWith('/api/')){
      if(request.method()!=='GET'){
        report.unexpectedRequests.push({method:request.method(),path:url.pathname});
        return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'This test never starts or mutates tasks'})});
      }
      if(url.pathname==='/api/tags')return json(data.tags);
      if(url.pathname==='/api/settings')return json(data.settings);
      if(url.pathname==='/api/memos')return json(data.memos);
      if(url.pathname==='/api/ai/status')return json({agent:'cc',name:'Claude Code',configured:true,busy:false,maintenance:false,task:'',elapsedMs:0});
      if(url.pathname==='/api/ai/task')return json({streamId:'filter-test',revision:0,task:null});
      if(url.pathname==='/api/ai/events')return route.fulfill({status:204,contentType:'text/event-stream',body:''});
      if(url.pathname==='/api/cc/suggestions')return json({dailyDigest:{date:now.slice(0,10),summary:'合成摘要：记录日常的小发现。'},weeklyDigests:[],tagSuggestions:[],graphHistory:[]});
      if(url.pathname==='/api/scheduled/pending')return json({pending:[]});
      report.unexpectedRequests.push({method:request.method(),path:url.pathname});return json({});
    }
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
    const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:'Not found'});
    return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
}

async function measure(page){
  return page.evaluate(()=>{
    const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const bar=document.querySelector('.filter-bar'),strip=document.querySelector('.cc-walk-strip'),cat=document.getElementById('ccScene'),search=document.querySelector('.search-bar'),tagList=document.getElementById('filterTags');
    const controls=[...document.querySelectorAll('.filter-bar .filter-label,.filter-bar .filter-tag,.filter-bar .filter-expand,#clearFilterBtn')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim(),...box(e)}));
    const catBox=box(cat),collisions=controls.filter(r=>catBox.left<r.right-.5&&catBox.right>r.left+.5&&catBox.top<r.bottom-.5&&catBox.bottom>r.top+.5).map(r=>r.text);
    return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,footerTop:document.querySelector('.app-footer').getBoundingClientRect().top,filter:box(bar),strip:box(strip),cat:catBox,search:box(search),gapAfterFilter:search.getBoundingClientRect().top-bar.getBoundingClientRect().bottom,tagContentRight:tagList.getBoundingClientRect().right-parseFloat(getComputedStyle(tagList).paddingRight),tagBoxes:[...tagList.querySelectorAll('.filter-tag')].map(e=>({tag:e.dataset.tag,title:e.title,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,...box(e)})),controls,collisions,selected:[...document.querySelectorAll('#filterTags .filter-tag.active')].map(e=>e.dataset.tag),expanded:document.querySelector('#filterTags [data-action="collapse"]')!==null,plan:window._ccCtrl.getIdlePlan(),age:performance.now()-window._ccCtrl.getIdlePlan().epoch,activity:window._ccActivity.getState(),hidden:document.hidden};
  });
}

function validateLayout(state,label){
  assert.ok(Math.abs(state.strip.height-8)<.05,label+': strip must remain 8px, '+JSON.stringify(state));
  assert.ok(Math.abs(state.gapAfterFilter-16)<.1,label+': no extra cat row after filters, '+state.gapAfterFilter);
  assert.ok(Math.abs(state.filter.bottom-Math.max(...state.controls.map(r=>r.bottom)))<1,label+': filter height must be occupied by actual controls');
  assert.ok(state.controls.every(control=>control.top>=state.filter.top-1 && control.right<=state.filter.right+1),label+': filter controls must stay inside their own bar');
  assert.deepEqual(state.collisions,[],label+': cat overlaps filter controls');
  assert.ok(state.tagBoxes.every(tag=>tag.right<=state.tagContentRight+1),label+': tags must not invade the reserved cat space');
  assert.ok(state.cat.left>=state.strip.left-.5 && state.cat.right<=state.strip.right+.5,label+': cat exceeds full strip');
  assert.ok(Math.abs(state.cat.bottom-state.search.top)<1,label+': paws must touch search panel');
  assert.ok(state.documentWidth<=state.viewport+1,label+': horizontal overflow');
  assert.ok(state.cat.bottom<=state.footerTop+1 && state.search.bottom<=state.footerTop+1,label+': cat and search must remain visible above the footer');
  assert.equal(state.hidden,false,label+': real idle clock requires a visible document');
  assert.equal(state.activity,'idle',label+': fixture must never invent a task');
  assert.equal(state.plan.active,true,label+': idle plan must remain active');
}

async function stableState(page,label){
  await page.waitForTimeout(250);
  const before=await measure(page);validateLayout(before,label);
  for(let i=0;i<3;i++){
    await page.evaluate(()=>{renderFilterTags();return syncAIStatus();});
    await page.waitForTimeout(120);
    const after=await measure(page);validateLayout(after,label+' repeated render '+i);
    assert.equal(after.plan.epoch,before.plan.epoch,label+': rerender/polling must not restart the same idle geometry');
  }
  const snapshot=await measure(page);await page.screenshot({path:path.join(out,label+'.png')});return snapshot;
}

async function runViewport(width,{longLabels=false,movement=true}={}){
  const label=width+(longLabels?'-long':'');
  currentName=label;const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1});
  await installRoutes(context,caseData(longLabels));const page=await context.newPage();currentPage=page;
  page.on('pageerror',error=>report.errors.push({width,message:error.message}));
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({width,message:message.text()});});
  await page.goto(origin,{waitUntil:'load'});
  await page.waitForFunction(()=>typeof window._ccCtrl?.getIdlePlan==='function'&&window._ccActivity.getState()==='idle'&&document.getElementById('digestText').textContent.includes('合成摘要'));
  await page.evaluate(()=>document.fonts.ready.then(()=>undefined));
  const run={width,longLabels,states:[]};report.runs.push(run);
  run.states.push({name:'all-collapsed',...await stableState(page,label+'-all-collapsed')});
  await page.locator('#filterTags [data-tag="mark"]').click();
  run.states.push({name:'mark-collapsed',...await stableState(page,label+'-mark-collapsed')});
  await page.locator('#filterTags [data-action="expand"]').click();
  run.states.push({name:'mark-expanded',...await stableState(page,label+'-mark-expanded')});
  await page.locator('#filterTags [data-tag="__all__"]').click();
  run.states.push({name:'all-expanded',...await stableState(page,label+'-all-expanded')});
  await page.locator('#filterTags [data-action="collapse"]').click();
  const collapsedAgain=await stableState(page,label+'-all-collapsed-again');
  await page.locator('#filterTags [data-tag="mark"]').click();
  await stableState(page,label+'-mark-before-clear');
  await page.locator('#clearFilterBtn').click();
  run.clearButton=await stableState(page,label+'-clear-button');
  assert.deepEqual(run.clearButton.selected,['__all__'],label+': the actual Clear button restores all notes');
  await page.locator('#filterTags [data-tag="mark"]').click();
  const selected=await stableState(page,label+'-mark-before-walk');
  run.selectedBeforeWalk=selected;
  assert.deepEqual(selected.selected,['mark']);
  for(const [collapsed,expanded]of [[run.states[0],run.states[3]],[run.states[1],run.states[2]]]){
    assert.ok(Math.abs((expanded.search.top-collapsed.search.top)-(expanded.filter.height-collapsed.filter.height))<1,width+': expansion may only add the filter rows themselves');
  }
  assert.ok(Math.abs(collapsedAgain.search.top-run.states[0].search.top)<1,width+': collapsing must restore the original search position');
  if(width>=900)assert.equal(selected.plan.bounds.canRoam,true,width+': a selected tag must leave a legal roaming channel');
  if(longLabels){
    const longTags=run.states[2].tagBoxes.filter(tag=>tag.tag.length>20);
    assert.equal(longTags.length,2);assert.ok(longTags.every(tag=>tag.title===tag.tag && tag.scrollWidth>tag.clientWidth),label+': clipped labels retain their full names in a title');
  }
  console.log(JSON.stringify({stage:'four-state-layout',width,longLabels,states:run.states.map(state=>({name:state.name,filterHeight:state.filter.height,stripHeight:state.strip.height,gapAfterFilter:state.gapAfterFilter,canRoam:state.plan.bounds.canRoam,collisions:state.collisions})),selectedCanRoam:selected.plan.bounds.canRoam}));
  if(!movement){
    run.layoutOnly=true;
  }else if(selected.plan.bounds.canRoam){
    const waitedAt=Date.now();
    await page.waitForFunction(()=>window._ccCtrl.getIdlePlan().phase==='walk',null,{timeout:35000});
    const walking=await measure(page);validateLayout(walking,width+' walking');
    assert.equal(walking.plan.epoch,selected.plan.epoch,width+': ordinary polls must not postpone walking');
    assert.ok(walking.age>=5000,width+': observe the real five-second initial dwell, never accelerate the production clock');
    await page.waitForTimeout(1400);
    const moved=await measure(page);validateLayout(moved,width+' moving');
    run.realMovement={wallWaitMs:Date.now()-waitedAt,walking,moved};
    assert.equal(moved.plan.epoch,selected.plan.epoch);
    assert.ok(Math.abs(moved.plan.position-walking.plan.position)>.2,width+': cat must actually move continuously after the dwell: '+JSON.stringify({from:walking.plan.position,to:moved.plan.position,target:walking.plan.target,bounds:walking.plan.bounds}));
    await page.screenshot({path:path.join(out,label+'-mark-moving.png')});
  }else{
    await page.waitForTimeout(22000);
    const resting=await measure(page);validateLayout(resting,width+' narrow rest');
    assert.equal(resting.plan.epoch,selected.plan.epoch);run.narrowRest=resting;
  }
  await context.close();currentPage=null;
}

(async()=>{
  browser=await chromium.launch({executablePath:process.env.MEMO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  if(process.env.MEMO_CAT_FILTER_LONG_ONLY!=='1'){
    for(const width of (process.env.MEMO_CAT_FILTER_WIDTHS||'1280,1536,390').split(',').map(Number))await runViewport(width);
  }
  for(const width of (process.env.MEMO_CAT_FILTER_LONG_WIDTHS||'390,320').split(',').map(Number))await runViewport(width,{longLabels:true,movement:false});
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);report.passed=true;
})().catch(async error=>{
  report.error=error.stack;process.exitCode=1;console.error(error.stack);
  if(currentPage)await currentPage.screenshot({path:path.join(out,'failed-'+currentName+'.png')}).catch(()=>{});
}).finally(async()=>{
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();console.log(JSON.stringify({passed:report.passed||false,viewports:report.runs.map(run=>run.width),errors:report.errors,error:report.error,evidence:out}));
});
