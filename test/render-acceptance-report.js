// Render existing acceptance evidence only. This command never starts a test or a model.
const fs=require('node:fs');
const path=require('node:path');
const project=path.resolve(__dirname,'..');
const output=path.join(__dirname,'acceptance-report.html');
const evidenceRoot=path.join(__dirname,'acceptance-evidence');
const warnings=[];
const providers=[
  {id:'codex',label:'Codex',file:'codex',mode:'real'},
  {id:'trae',label:'Trae',file:'trae',mode:'real'},
  {id:'codebuddy',label:'CodeBuddy',file:'codebuddy',mode:'real'},
  {id:'cc',label:'CC',file:'cc-simulation',mode:'simulation'}
];
const traeRestriction='Trae 国内 CLI 2 仅向企业旗舰版开放；当前个人账号没有该 CLI 的企业旗舰权限。';
const traeOfficialLinks='<a href="https://docs.trae.cn/cli_about-trae-code-cli-2">官方 CLI 2 使用限制</a> · <a href="https://docs.trae.cn/trae-enterprise_billing-overview-for-trae-enterprise?lang=zh">官方企业套餐对照</a>';
function blockedReason(provider,row){return provider.id==='trae'&&row.status==='blocked'?(reports.get('trae')?.accountRestriction?.reason||traeRestriction):row.detail||row.error||'';}
function json(file){
  if(!fs.existsSync(file))return null;
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){warnings.push(path.relative(project,file)+' 无法读取：'+error.message);return null;}
}
function text(file){try{return fs.readFileSync(file,'utf8');}catch{return '';}}
function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function relative(file){return path.relative(__dirname,file).split(path.sep).map(encodeURIComponent).join('/');}
function link(file,label){return fs.existsSync(file)?`<a href="${relative(file)}">${esc(label)}</a>`:`<span class="muted">${esc(label)}（尚无文件）</span>`;}
function raw(value){return `<pre>${esc(JSON.stringify(value,null,2))}</pre>`;}
function date(value){if(!value)return '尚未记录';try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}catch{return esc(value);}}
function duration(value){if(!Number.isFinite(value))return '—';return value<1000?Math.round(value)+' ms':(value/1000).toFixed(1)+' 秒';}
const normalStatus=value=>['passed','failed','issue','blocked','running','skipped','not_tested','unverified'].includes(value)?value:'not_tested';
function badge(status,kind=''){
  status=normalStatus(status);
  const labels={passed:kind==='simulation'?'✅ 模拟通过':kind==='api'?'✅ API 通过':kind==='fixed'?'✅ 修复后复验通过':'✅ 通过',failed:'✗ 失败',issue:'⚠ 发现问题',blocked:'⏸ 受阻',running:'● 进行中',skipped:'○ 跳过',not_tested:'○ 未测',unverified:'○ 未确认'};
  return `<span class="badge ${status} ${kind==='api'?'api':kind==='simulation'&&status==='passed'?'simulation':''}">${labels[status]}</span>`;
}
function filterAttrs(scope,statuses,search){return `class="filterable" data-scope="${esc(scope)}" data-status="${esc([...new Set(statuses.map(normalStatus))].join(' '))}" data-search="${esc(search.toLowerCase())}"`;}
function counts(rows){return rows.reduce((all,row)=>{const status=normalStatus(row.status);all[status]=(all[status]||0)+1;return all;},{});}
function countLabel(rows){const c=counts(rows);return [`通过 ${c.passed||0}`,`失败 ${c.failed||0}`,`受阻 ${c.blocked||0}`,`进行中 ${c.running||0}`,`未测 ${(c.not_tested||0)+(c.skipped||0)+(c.unverified||0)}`].join(' · ');}
const reports=new Map(providers.map(provider=>[provider.id,json(path.join(evidenceRoot,'live',provider.file+'.json'))]));
const catalog=new Map();
// The runner is a catalogue fallback for an interrupted or not-yet-started run.
for(const match of text(path.join(__dirname,'acceptance-live.js')).matchAll(/await check\('([^']+)','([^']+)','([^']+)'/g))catalog.set(match[1],{id:match[1],name:match[2].replace(/真实|模拟/g,''),scope:match[3]});
for(const report of reports.values())for(const row of report?.cases||[])if(!catalog.has(row.id))catalog.set(row.id,{id:row.id,name:row.name.replace(/真实|模拟/g,''),scope:row.scope});
const cases=[...catalog.values()];
function record(provider,id){
  const report=reports.get(provider.id),row=report?.cases?.find(item=>item.id===id);
  if(!row)return {status:'not_tested',detail:report?.finishedAt?'本轮报告没有此项记录。':'尚无执行结果；不能依据其他助手或模拟测试补勾。'};
  if(report.mode!==provider.mode)return {...row,status:'unverified',detail:'证据模式与本列不符；不能作为本列通过依据。'};
  return row;
}
function matrix(){return cases.map((item,index)=>{
  const records=providers.map(provider=>record(provider,item.id));
  const cells=providers.map((provider,i)=>{
    const row=records[i],kind=item.scope==='common'?'api':provider.mode;
    return `<td><a class="status-link" href="#detail-${esc(item.id)}-${provider.id}">${badge(row.status,kind)}</a><small>${esc(item.scope==='common'?'通用 HTTP/API':provider.mode==='simulation'?'模拟 CLI / 模拟模型':'真实 CLI / 真实模型')}</small>${row.retestSource?'<small><a href="#fix-retests">修复后复验，保留初轮失败</a></small>':''}</td>`;
  }).join('');
  const details=providers.map((provider,i)=>{
    const row=records[i],report=reports.get(provider.id),file=path.join(evidenceRoot,'live',provider.file+'.json');
    return `<details id="detail-${esc(item.id)}-${provider.id}"><summary>${esc(provider.label)} · ${duration(row.elapsedMs)}${row.status==='blocked'?' · 需要处理':''}</summary><p>${esc(blockedReason(provider,row)||(row.status==='passed'?'本轮断言通过，完整记录见下方 JSON。':'等待执行完成。'))}</p>${provider.id==='trae'&&row.status==='blocked'?'<p>'+traeOfficialLinks+'</p>':''}<p class="meta">开始 ${date(row.startedAt)} · 完成 ${date(row.finishedAt)} · 模式 ${esc(report?.mode||'未记录')}</p>${raw(row)}<p class="evidence-links">${link(file,'原始 JSON')} · ${link(path.join(evidenceRoot,'live',provider.file+'.runner.log'),'执行日志')} · ${link(path.join(evidenceRoot,'live',provider.file+'.server.log'),'服务日志')}${row.retestSource?' · '+link(path.join(evidenceRoot,'live',row.retestSource),'本项修复后真实复验 JSON')+(report?.retest?.runnerLog?' · '+link(path.join(evidenceRoot,'live',report.retest.runnerLog),'本项复验日志'):''):''}</p></details>`;
  }).join('');
  return `<tr ${filterAttrs(item.scope,records.map(row=>row.status),[item.id,item.name,...records.map(row=>row.detail||'')].join(' '))}><th scope="row"><span class="row-number">${String(index+1).padStart(2,'0')}</span>${esc(item.name)}<small>${esc(item.id)} · ${item.scope==='common'?'通用接口功能':'AI 功能'}</small></th>${cells}<td class="evidence"><details><summary>查看各列证据</summary>${details}</details></td></tr>`;
}).join('');}

const commonFile=path.join(evidenceRoot,'common','common-ui.json'),common=json(commonFile);
const uiEdgesFile=path.join(evidenceRoot,'common','ui-edges.json'),uiEdges=json(uiEdgesFile);
const uiBatches=[{file:commonFile,report:common},{file:uiEdgesFile,report:uiEdges}].filter(batch=>batch.report);
const uiRows=uiBatches.flatMap(batch=>batch.report.checks||[]);
const uiFinishedAt=uiBatches.map(batch=>batch.report.finishedAt).filter(Boolean).sort().at(-1);
function uiTable(){return uiRows.map(row=>{
  const file=uiBatches.find(batch=>batch.report.checks?.includes(row))?.file;
  return `<tr ${filterAttrs('ui',[row.status],row.id+' '+row.name)}><th scope="row">${esc(row.id)} · ${esc(row.name)}</th><td>${badge(row.status)}</td><td><span>${esc(row.method||'真实渲染器控件 + 隔离 HTTP 后端；不调用模型')}</span>${row.simulation?.length?'<p class="meta"><strong>模拟 / 注入范围：</strong>'+esc(row.simulation.join('；'))+'</p>':''}<details><summary>查看断言记录${row.error?'与错误':''}</summary>${raw(row)}</details><p>${file?link(file,'所属 UI JSON'):''}${row.screenshot?' · '+link(path.join(evidenceRoot,'common',row.screenshot),'截图'):''}${row.details?.progressScreenshot?' · '+link(path.join(evidenceRoot,'common',row.details.progressScreenshot),'生成进度截图'):''}</p></td></tr>`;
}).join('')||'<tr><td colspan="3" class="empty">尚无通用 UI 执行记录。</td></tr>';}
function notApplicable(){return (uiEdges?.notApplicable||[]).map(row=>`<p><strong>不适用：${esc(row.name)}</strong> · ${esc(row.reason)}</p>`).join('');}

const realUiProviders=providers.filter(provider=>provider.mode==='real');
const realUiReports=new Map(realUiProviders.map(provider=>[provider.id,json(path.join(evidenceRoot,'live-ui',provider.id,'result.json'))]));
const realUiCatalog=[
  {id:'tag-stream-ui',name:'标签整理：真实文本增量、任务锁、关闭重开与历史保存',screenshots:['tag-stream-partial.png','tag-stream-completed.png']},
  {id:'daily-digest-ui',name:'今日摘要：点击生成、折叠展开与保存',screenshots:['daily-digest-expanded.png']},
  {id:'graph-ui',name:'图谱：点击生成、D3 展示与关闭重开历史',screenshots:['graph-generated.png','graph-history.png'],visualIds:['graph-readability']},
  {id:'weekly-tag-range-ui',name:'单标签周总结：选择范围、点击生成、展开与历史保存',screenshots:['weekly-tag-selected.png','weekly-tag-summary.png']}
];
function realUiRecord(provider,id){
  const report=realUiReports.get(provider.id),row=report?.checks?.find(item=>item.id===id);
  if(row){
    if(row.status==='blocked'&&report.mode==='real-cli-ui-blocked'&&report.realCliInvoked===false)return {...row,detail:row.reason||report.reason};
    if(report.mode!=='real-cli-ui'||report.realCli!==true||report.fakeModel!==false)return {...row,status:'unverified',detail:'界面报告未确认使用真实 CLI 且未替换模型，不能勾为真实 UI 通过。'};
    return row;
  }
  const blocked=(reports.get(provider.id)?.cases||[]).find(item=>item.scope==='ai'&&item.status==='blocked');
  if(blocked)return {id,status:'blocked',detail:'本项真实 UI 尚未执行。外部阻塞条件：'+blockedReason(provider,blocked)};
  if(report?.currentCheck?.id===id&&!report.success)return {id,status:report.error?'failed':'running',detail:report.error||'真实界面脚本正在执行此项。'};
  return {id,status:'not_tested',detail:'尚无本项真实界面执行记录；不以主矩阵 API 结果或模拟 UI 结果补勾。'};
}
function realUiTable(){return realUiCatalog.map(item=>{
  const records=realUiProviders.map(provider=>realUiRecord(provider,item.id));
  const cells=realUiProviders.map((provider,index)=>`<td><a class="status-link" href="#detail-ui-${item.id}-${provider.id}">${badge(records[index].status)}</a><small>实际界面 / 真实 CLI</small>${visualRows.some(row=>row.provider===provider.label&&row.status==='issue'&&item.visualIds?.includes(row.id))?'<a class="visual-warning" href="#visual-review">⚠ 视觉复查有问题</a>':''}</td>`).join('');
  const details=realUiProviders.map((provider,index)=>{
    const row=records[index],folder=path.join(evidenceRoot,'live-ui',provider.id),report=realUiReports.get(provider.id);
    const screenshots=item.screenshots.filter(name=>report?.screenshots?.includes(name)&&fs.existsSync(path.join(folder,name)));
    return `<details id="detail-ui-${item.id}-${provider.id}"><summary>${esc(provider.label)} · ${esc(row.label||row.status)}</summary><p>${esc(row.detail||row.error||(row.status==='passed'?'实际界面断言通过；真实模型回答经后端校验后保存。':'等待执行结果。'))}</p>${raw(row)}<p class="evidence-links">${link(path.join(folder,'result.json'),'原始真实 UI JSON')} · ${link(path.join(folder,'run.log'),'执行日志')}${screenshots.map(name=>' · '+link(path.join(folder,name),name)).join('')}</p></details>`;
  }).join('');
  return `<tr ${filterAttrs('real-ui',records.map(row=>row.status),item.id+' '+item.name)}><th scope="row">${esc(item.name)}<small>${esc(item.id)}</small></th>${cells}<td class="evidence"><details><summary>真实界面证据与截图</summary>${details}</details></td></tr>`;
}).join('');}
function realUiSummary(){return realUiProviders.map(provider=>{
  const report=realUiReports.get(provider.id),rows=realUiCatalog.map(item=>realUiRecord(provider,item.id));
  return `<p><strong>${esc(provider.label)}</strong>：${esc(countLabel(rows))}${report?.success===true?' · 界面脚本已完成':''}${report?.cliVersion?' · '+esc(report.cliVersion):''}${Number.isFinite(report?.elapsedMs)?' · '+duration(report.elapsedMs):''}</p>`;
}).join('');}

const visualRows=realUiProviders.flatMap(provider=>{
  const folder=path.join(evidenceRoot,'live-ui',provider.id),file=path.join(folder,'visual-review.json'),review=json(file);
  return (review?.observations||[]).map(row=>({...row,sourceStatus:row.status,status:row.status==='issue-observed'?'issue':row.status==='fixed-and-retested'?'passed':normalStatus(row.status),provider:provider.label,folder,file,reviewedAt:review.reviewedAt}));
});
const visualIssues=visualRows.filter(row=>row.status==='issue').length;
function visualTable(){return visualRows.map(row=>{
  const screenshots=[...new Set([row.screenshot,...(row.screenshots||[])].filter(Boolean))];
  return `<tr ${filterAttrs('visual',[row.status],row.provider+' '+row.id+' '+row.finding)}><th scope="row">${esc(row.provider)} · ${esc(row.id)}</th><td>${badge(row.status,row.sourceStatus==='fixed-and-retested'?'fixed':'')}</td><td>${esc(row.finding)}<p class="meta">复查时间：${date(row.reviewedAt)}</p>${row.metrics?'<details><summary>复验指标</summary>'+raw(row.metrics)+'</details>':''}<p>${link(row.file,'视觉复查 JSON')}${screenshots.map(name=>' · '+link(path.join(row.folder,name),name)).join('')}${row.functionalReport?' · '+link(path.join(row.folder,row.functionalReport),'真实功能复验报告'):''}</p></td></tr>`;
}).join('')||'<tr><td colspan="3" class="empty">尚无独立截图复查记录；功能断言不代表视觉质量已验收。</td></tr>';}
const graphRetestRows=realUiProviders.flatMap(provider=>{
  const folder=path.join(evidenceRoot,'live-ui',provider.id),file=path.join(folder,'graph-retest.json'),report=json(file);
  if(!report)return [];
  const check=report.checks?.find(row=>row.id==='graph-ui');
  const verified=report.mode==='real-cli-ui-graph-retest'&&report.realCli===true&&report.fakeModel===false;
  const status=!verified?'unverified':check?.status||(report.error?'failed':report.currentCheck?.id==='graph-ui'?'running':'not_tested');
  return [{provider:provider.label,status,check,folder,file,report}];
});
function graphRetestTable(){if(!graphRetestRows.length)return '';return '<h3>图谱修复后的真实 CLI 界面复验</h3><div class="table-wrap"><table><thead><tr><th>助手</th><th>状态</th><th>断言与截图</th></tr></thead><tbody>'+graphRetestRows.map(row=>`<tr ${filterAttrs('visual',[row.status],row.provider+' graph-retest 图谱复验')}><th scope="row">${esc(row.provider)}</th><td>${badge(row.status)}</td><td><p>真实 CLI / 真实模型 · ${date(row.report.finishedAt||row.report.startedAt)}</p>${row.report.error?'<p>'+esc(row.report.error)+'</p>':''}<details><summary>复验断言</summary>${raw(row.check||row.report.currentCheck||{})}</details><p>${link(row.file,'图谱复验 JSON')} · ${link(path.join(row.folder,'graph-retest.log'),'复验日志')}${(row.report.screenshots||[]).map(name=>' · '+link(path.join(row.folder,name),name)).join('')}</p></td></tr>`).join('')+'</tbody></table></div>';}

const logSpecifications=[
  {file:'legacy-ui.log',label:'通用界面与图谱 / 模拟回答',sentinel:'overlayClose',checks:[
    ['S01','助手选择、刷新保留、运行中锁定与控件布局',['agentSelection','agentReload','agentBusyLock','agentLayout']],
    ['S02','实时回答、关闭重开与失败状态',['streamingReply','streamReopen','streamFailure']],
    ['S03','缺失 CLI 的产品名称提示',['agentMissingMessage']],
    ['S04','本地搜索、无结果和旧摘要空状态',['localSearch','emptySearch','legacyDigestFriendly','emptyDigestFriendly']],
    ['S05','图谱展开/折叠、来源面板和来源改删处理',['sourcePanel','editedSource','deletedSource']],
    ['S06','空图拒绝、不误报成功与 Markdown 安全展示',['emptyGraphRejected','failureBubble','markdownSafe']],
    ['S07','空卡池恢复、超限备份阻止和存储错误文案',['emptyPoolRecovery','oversizedBackupBlocked','friendlyStorageErrors']],
    ['S08','点击弹窗遮罩关闭',['overlayClose']],
    ['S16','图谱 Enter/Space 键盘选择与来源便签详情',['graphKeyboardEnterAndSpace','graphSourceDetail']],
    ['S17','图谱滚轮缩放、节点拖动及拖动释放',['graphZoom','graphDrag']],
    ['S18','图谱全屏进出、窗口调整与过渡后几何',['graphFullscreen','graphResize']],
    ['S19','图谱历史上一张/下一张、删除取消及删除最后一张',['graphPreviousAndNext','graphDeleteCancel','graphDeleteLast']],
    ['S20','愿望预设回答完成生成、换个愿望重置',['wishPresetAnswers','wishRestart']],
    ['S21','图谱关系文字默认隐藏，避免全部标签堆叠',['graphRelationDefaultHidden']],
    ['S22','图谱悬停仅显示当前节点的相邻关系',['graphRelationHoverAdjacentOnly']],
    ['S23','图谱长关系文字缩短至 12 个码点',['graphRelationShortened']],
    ['S24','图谱完整关系文字保留在标题提示',['graphRelationFullTitle']],
    ['S25','图谱移开鼠标后关系文字恢复隐藏',['graphRelationMouseleaveReset']],
    ['S26','图谱关系文字响应键盘聚焦与失焦',['graphRelationFocusAndBlur']],
    ['S27','图谱键盘选中的关系在失焦后保持',['graphRelationKeyboardSelectionPersists']]
  ]},
  {file:'task-stream-ui.log',label:'流式断线与快照容错 / 模拟事件',sentinel:'noStreamingFallback',checks:[
    ['S09','静默流停滞、漏帧与重复增量恢复',['silentStreamRecovery','duplicateDeltaIgnored','missingDeltaRecovered']],
    ['S10','完成状态恢复与旧轮询不覆盖新结果',['completionRecovered','stalePollIgnored']],
    ['S11','服务重启恢复、旧事件丢弃与旧协议兼容',['restartRecovered','legacyStreamingAfterPoll']],
    ['S12','没有 EventSource 时退回快照',['noStreamingFallback']]
  ]},
  {file:'wish-ui.log',label:'愿望对话界面 / 模拟回答',sentinel:'savedCards',checks:[
    ['S13','两轮引导、三个选项加“其他”与自由回答',['twoGuidedQuestions','fourOptions','customAnswers']],
    ['S14','收起重开对话与窄屏布局',['collapseAndReopen','narrowLayout']],
    ['S15','拒绝错误卡池、保留回答后重试',['invalidResultsRejected','retry']]
  ]}
];
const supplemental=[];
const logNotes=[];
const uiSmokeFile=path.join(evidenceRoot,'common','ui-smoke-summary.json');
const uiSmoke=json(uiSmokeFile);
const supplementalScreenshots={S02:['task-stream-partial.png'],S05:['graph-expanded.png','graph-collapsed.png'],S18:['graph-fullscreen.png'],S20:['wish-preset-success.png'],S21:['graph-default.png']};
for(const spec of logSpecifications){
  const filename=path.join(evidenceRoot,'common',spec.file),content=text(filename),payloads=[];
  for(const line of content.split('\n')){try{const row=JSON.parse(line);if(row&&typeof row==='object')payloads.push(row);}catch{}}
  const summaryRun=uiSmoke?.runs?.find(run=>run.evidence===spec.file);
  const summaryCurrent=summaryRun&&fs.existsSync(filename)&&fs.statSync(uiSmokeFile).mtimeMs>=fs.statSync(filename).mtimeMs;
  const payload=summaryCurrent?summaryRun.assertions:payloads.findLast(row=>Object.hasOwn(row,spec.sentinel));
  if(summaryCurrent)for(const warning of summaryRun.warnings||[])logNotes.push({label:spec.label,file:filename,detail:warning});
  else if(/UnhandledPromiseRejectionWarning|UnhandledPromiseRejection|uncaughtException/.test(content))logNotes.push({label:spec.label,file:filename,detail:'日志含未处理异常或清理异常；功能断言与整次进程退出状态需要分开看。'});
  for(const [id,name,keys]of spec.checks){
    const missing=keys.some(key=>!payload||!Object.hasOwn(payload,key));
    const proof=payload?Object.fromEntries(keys.map(key=>[key,payload[key]])):{};
    if(id==='S05'){proof.expandedNodes=payload?.expandedNodes;proof.collapsedClusters=payload?.collapsedClusters;}
    if(id==='S18')proof.graphFullscreenGeometry=(summaryCurrent?summaryRun.fullscreenGeometry:null)||payloads.findLast(item=>item.graphFullscreenGeometry===true)||null;
    if(Number(id.slice(1))>=21)proof.graphRelations=(summaryCurrent?summaryRun.graphRelations:null)||payloads.findLast(item=>item.graphRelationsRegression===true)||null;
    const extraPassed=id==='S05'?proof.expandedNodes>0&&proof.collapsedClusters>0:id==='S18'?proof.graphFullscreenGeometry?.graphFullscreenGeometry===true:true;
    const screenshots=(supplementalScreenshots[id]||[]).map(name=>path.join(evidenceRoot,'common','legacy-ui',name)).filter(file=>fs.existsSync(file));
    supplemental.push({id,name,source:spec.label,file:filename,status:missing?'not_tested':keys.every(key=>payload[key]===true)&&extraPassed?'passed':'failed',evidence:proof,screenshots,detail:missing?'没有找到本轮完成断言记录。':'该项来自实际 UI 脚本中的断言；AI 回答或流式事件是模拟数据。图谱交互实际使用 D3 渲染器和输入事件。'});
  }
}
function supplementalTable(){return supplemental.map(row=>`<tr ${filterAttrs('ui',[row.status],row.id+' '+row.name)}><th scope="row">${esc(row.id)} · ${esc(row.name)}</th><td>${badge(row.status,'simulation')}</td><td>${esc(row.source)}<details><summary>断言证据</summary><p>${esc(row.detail)}</p>${raw(row.evidence)}<p class="evidence-links">${link(row.file,'原始日志')}${row.screenshots.map(file=>' · '+link(file,path.basename(file))).join('')}</p></details></td></tr>`).join('');}

const suite=json(path.join(evidenceRoot,'simulation','suite-result.json'));
const suiteRows=suite?.cases||[];
const groupNames={'acp.test.js':'Trae ACP 合同','agents.test.js':'四助手 CLI 适配','agent-api.test.js':'助手选择与任务互斥','api-edges.test.js':'空状态与 API 边界','api.test.js':'API 与持久化','habit-wish.test.js':'愿望流程与卡片校验','live-task.test.js':'回答流与快照','messages.test.js':'面向用户的提示','scheduling.test.js':'定时摘要与提醒','storage.test.js':'SQLite、迁移与备份','tasks.test.js':'搜索、日期、范围与 AI 结果校验'};
function regressionTable(){return suiteRows.map((row,index)=>{
  const file=path.resolve(project,row.file||''),group=groupNames[path.basename(file)]||'通用回归';
  return `<tr ${filterAttrs('regression',[row.status],row.name+' '+group+' '+row.file)}><th scope="row"><span class="row-number">${index+1}</span>${esc(group)}<small>${esc(row.name)}</small></th><td>${badge(row.status,'simulation')}</td><td>${duration(row.durationMs)} · ${link(file,(row.file||'源码')+(row.line?':'+row.line:''))}${row.error?`<details><summary>错误</summary>${raw(row.error)}</details>`:''}</td></tr>`;
}).join('')||'<tr><td colspan="3" class="empty">尚无通用回归结果。</td></tr>';}

const cc=json(path.join(evidenceRoot,'simulation','cc-result.json'));
function ccTable(){return (cc?.rows||[]).map(row=>`<tr ${filterAttrs('cc',[row.status],row.id+' '+row.label)}><th scope="row">${esc(row.label)}<small>${esc(row.id)}</small></th><td>${badge(row.status,'simulation')}</td><td>${duration(row.durationMs)}<details><summary>模拟断言证据</summary>${raw(row.details||row.error||{})}</details></td></tr>`).join('')||'<tr><td colspan="3" class="empty">尚无 CC 专项模拟结果。</td></tr>';}

const codebuddyRetestFile=path.join(evidenceRoot,'live','codebuddy-retest.json'),codebuddyRetest=json(codebuddyRetestFile);
const codebuddyRetestRows=['daily_digest','daily_scheduled'].map(id=>{
  const row=codebuddyRetest?.cases?.find(item=>item.id===id);
  if(!row)return {id,name:id==='daily_digest'?'手动日摘要：90 条记录 / 两批':'定时日摘要回调与保存',status:'not_tested'};
  return codebuddyRetest.mode==='real'&&codebuddyRetest.agent==='codebuddy'?row:{...row,status:'unverified'};
});
const liveFolder=path.join(evidenceRoot,'live');
const codebuddyArchived=fs.existsSync(liveFolder)?fs.readdirSync(liveFolder).filter(name=>/codebuddy.*(?:original|initial|before|archive).*\.json$/i.test(name)).map(name=>path.join(liveFolder,name)):[];
function codebuddyFixSection(){if(!codebuddyRetest)return '';return `<section id="fix-retests" class="section"><div class="section-head"><h2>CodeBuddy 日摘要修复与真实 CLI 复验</h2><p>初轮真实模型将 tasks 返回为对象数组，应用要求文字数组，手动与定时日摘要因格式校验失败而未保存。已明确日摘要提示词和校验失败后的格式修正要求。下表记录隔离临时库中的真实复验；原始失败与修复后结果均可追溯。</p><p>${link(path.join(liveFolder,'codebuddy-digest-reproduction.json'),'原始返回与失败复现')} · ${link(codebuddyRetestFile,'修复后真实复验 JSON')} · ${link(path.join(liveFolder,'codebuddy-retest.runner.log'),'复验执行日志')}${codebuddyArchived.map(file=>' · '+link(file,'初轮原报告：'+path.basename(file))).join('')}</p>${reports.get('codebuddy')?.retest?'<details><summary>主矩阵复验合并记录</summary>'+raw(reports.get('codebuddy').retest)+'</details>':''}</div><div class="table-wrap"><table><thead><tr><th>功能</th><th>最新复验</th><th>断言证据</th></tr></thead><tbody>${codebuddyRetestRows.map(row=>`<tr ${filterAttrs('repair',[row.status],row.id+' '+row.name)}><th scope="row">${esc(row.name)}<small>${esc(row.id)}</small></th><td>${badge(row.status)}<small>真实 CLI / 真实模型</small></td><td>${duration(row.elapsedMs)}<details><summary>查看本轮断言</summary>${raw(row)}</details></td></tr>`).join('')}</tbody></table></div></section>`;}

const closureFolder=path.join(evidenceRoot,'trae-closure'),closureUiFile=path.join(closureFolder,'ui.json'),closureUi=json(closureUiFile),closureUiRows=closureUi?.checks||[];
const closureResultFile=path.join(closureFolder,'result.json'),closureResult=json(closureResultFile),closureExtraRows=[];
for(const [id,key,name]of [['TD01','desktopStartup','原生桌面启动'],['TD02','selectedAgentSetup','CodeBuddy 安装与所选助手设置'],['TD03','nativePathSelection','原生可执行文件路径选择'],['TD04','noServerRestart','选择路径后无需重启服务'],['TD05','desktopGeneration','桌面生成与保存（模拟 CodeBuddy 输出）']]){
  const desktop=closureResult?.desktop;
  if(desktop)closureExtraRows.push({id,name,status:desktop[key]===true?'passed':desktop[key]===false?'failed':'not_tested',method:'实际 Electron 桌面及原生路径选择；合成 CLI，不调用真实模型',evidence:{[key]:desktop[key],agent:desktop.agent,fakeCli:desktop.fakeCli},file:path.join(closureFolder,desktop.log)});
}
for(const [index,row]of (closureResult?.runnerRejection?.checks||[]).entries())closureExtraRows.push({id:'TR0'+(index+1),name:row.script+' 拒绝 Trae（预期退出码 1）',status:row.status,method:'启动前拒绝已关闭助手；无模型调用',evidence:row,file:path.resolve(project,row.log)});
if(closureResult?.runnerRejection)closureExtraRows.push({id:'TE01',name:'保留关闭前真实 CLI 界面证据',status:closureResult.runnerRejection.realUiEvidenceUnchanged===true?'passed':'unverified',method:'比较历史证据哈希；不重新调用模型',evidence:{unchanged:closureResult.runnerRejection.realUiEvidenceUnchanged,files:closureResult.runnerRejection.realUiEvidenceFiles},file:path.join(closureFolder,'runner-rejection.json')});
if(closureResult?.regression)closureExtraRows.push({id:'TS01',name:'关闭后完整回归：'+closureResult.regression.passed+' 通过 / '+closureResult.regression.failed+' 失败',status:closureResult.regression.failed===0&&closureResult.regression.passed>0?'passed':'failed',method:'临时数据库与模拟 CLI；底层保留四适配器，应用只开放三助手',evidence:closureResult.regression,file:path.join(closureFolder,closureResult.regression.log)});
if(closureResult?.trae?.backupReadbackVerified!==undefined)closureExtraRows.push({id:'TB01',name:'Trae 适配备份 ZIP 可完整读取：19 个源文件/测试及 1 份说明',status:closureResult.trae.backupReadbackVerified===true?'passed':'failed',method:'读取全部 ZIP 条目并核对内容；不含账号配置或日记',evidence:closureResult.trae,file:path.join(project,closureResult.trae.backup)});
function closureSection(){return `<section id="trae-closure" class="section"><div class="section-head"><h2>Trae 入口关闭后的独立复验</h2><p>此节只记录关闭入口后的新结果，不继承下方历史矩阵的勾号。当前可选助手为 cc、codex、codebuddy；四适配器底层代码保留。</p><p>界面复验：${esc(countLabel(closureUiRows))} · 完成时间 ${date(closureUi?.finishedAt)}。实际操作渲染器、HTTP 与临时 SQLite；使用合成 CLI，一次模拟 Codex 任务，真实模型调用为零。</p><p>${link(closureResultFile,'关闭后验证汇总 JSON')} · ${link(closureUiFile,'关闭后 UI JSON')} · ${link(path.join(closureFolder,'targeted-tests.log'),'定向回归日志')} · ${link(path.join(closureFolder,'full-suite.log'),'完整回归日志')} · ${link(path.join(closureFolder,'ui.log'),'UI 日志')} · ${link(path.join(closureFolder,'ui-server.log'),'UI 后端日志')}</p><details><summary>本轮模拟范围</summary>${raw(closureUi?.simulation||[])}</details></div><div class="table-wrap"><table><thead><tr><th>关闭后检查</th><th>状态</th><th>实际方法与证据</th></tr></thead><tbody>${closureUiRows.map(row=>`<tr ${filterAttrs('closure',[row.status],row.id+' '+row.name)}><th scope="row">${esc(row.id)} · ${esc(row.name)}</th><td>${badge(row.status)}</td><td>实际 UI / 隔离后端；模型输出按上方范围模拟<details><summary>断言记录</summary>${raw(row)}</details>${row.screenshot?link(path.join(closureFolder,row.screenshot),'截图'):''}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">尚无关闭后的 UI 复验记录，未使用历史测试代替。</td></tr>'}${closureExtraRows.map(row=>`<tr ${filterAttrs('closure',[row.status],row.id+' '+row.name)}><th scope="row">${esc(row.id)} · ${esc(row.name)}</th><td>${badge(row.status)}</td><td>${esc(row.method)}<details><summary>断言记录</summary>${raw(row.evidence)}</details>${link(row.file,'本项原始证据')}</td></tr>`).join('')}</tbody></table></div><p class="meta">适配备份 SHA-256：${esc(closureResult?.trae?.sha256||'尚无记录')}</p></section>`;}

const allUiNames=uiRows.filter(row=>row.status==='passed').map(row=>row.name).join(' ');
const omissions=[
  {id:'U01',name:'macOS 系统通知横幅实际送达与通知权限',detail:'当前提醒证据验证的是队列、回调、去重和消费；没有将系统通知横幅实际出现记为通过。',covered:/系统通知横幅实际|系统通知.*送达/.test(allUiNames)},
  {id:'U02',name:'标签拖动排序、标签较多时展开/收起',detail:'接口中保存 tagOrder 不等于拖动控件已实际验收；现有 UI 完成记录未单独涵盖此项。',covered:/标签.*拖动.*展开|标签.*排序.*收起/.test(allUiNames)},
  {id:'U03',name:'图谱缩放、拖动、键盘选择和全屏切换',detail:'已有图谱节点/折叠/来源面板验证；这些图谱交互尚无独立完成记录。',covered:/图谱.*缩放.*拖动.*全屏/.test(allUiNames)||['S16','S17','S18'].every(id=>supplemental.some(row=>row.id===id&&row.status==='passed'))},
  {id:'U05',name:'独立安装包与其他操作系统实机运行',detail:'本报告基于当前 Mac 上的源码、Electron 渲染器与隔离服务；DMG 安装/Finder 冷启动、Windows/Linux 实机运行未据此打勾。',covered:false},
  {id:'U06',name:'真实 Claude Code CLI 与真实模型生成',detail:'本机没有 Claude Code CLI；CC 列和 CC 专项均为模拟 CLI / 模拟模型，不代表真实账号可用性或内容质量。',covered:false}
].filter(row=>!row.covered);
function omissionsTable(){return omissions.map(row=>`<tr ${filterAttrs('uncovered',['not_tested'],row.id+' '+row.name)}><th scope="row">${esc(row.id)} · ${esc(row.name)}</th><td>${badge('not_tested')}</td><td>${esc(row.detail)}</td></tr>`).join('');}

function providerCard(provider){
  const report=reports.get(provider.id),rows=cases.map(item=>({...record(provider,item.id),scope:item.scope})),commonRows=rows.filter(row=>row.scope==='common'),aiRows=rows.filter(row=>row.scope==='ai');
  const summary=provider.mode==='simulation'?'模拟 CLI / 模拟模型':'真实 CLI / 真实模型';
  return `<article class="summary-card"><h2>${esc(provider.label)} <span>${esc(summary)}</span></h2><p><strong>AI 功能</strong> ${esc(countLabel(aiRows))}</p><p><strong>通用 API</strong> ${esc(countLabel(commonRows))}</p><p class="meta">${report?.finishedAt?'本轮已结束':'本轮尚未结束或尚无记录'} · ${date(report?.finishedAt||report?.startedAt)}</p><p>${link(path.join(evidenceRoot,'live',provider.file+'.json'),'原始报告')}</p></article>`;
}
const blocked=providers.filter(provider=>provider.mode==='real').flatMap(provider=>cases.map(item=>({provider,...record(provider,item.id)})).filter(row=>row.status==='blocked'));
const failed=providers.flatMap(provider=>cases.map(item=>record(provider,item.id))).filter(row=>row.status==='failed').length+realUiProviders.flatMap(provider=>realUiCatalog.map(item=>realUiRecord(provider,item.id))).filter(row=>row.status==='failed').length+uiRows.filter(row=>row.status==='failed').length+supplemental.filter(row=>row.status==='failed').length+graphRetestRows.filter(row=>row.status==='failed').length+closureUiRows.filter(row=>row.status==='failed').length+closureExtraRows.filter(row=>row.status==='failed').length+suiteRows.filter(row=>row.status==='failed').length+(cc?.rows||[]).filter(row=>row.status==='failed').length;
const generatedAt=new Date().toISOString();
const sourceLinks=[...providers.map(provider=>link(path.join(evidenceRoot,'live',provider.file+'.json'),provider.label+' JSON')),...realUiProviders.map(provider=>link(path.join(evidenceRoot,'live-ui',provider.id,'result.json'),provider.label+' 真实 UI JSON')),link(path.join(evidenceRoot,'common','common-ui.json'),'通用 UI JSON'),link(path.join(evidenceRoot,'simulation','suite-result.json'),'回归 JSON'),link(path.join(evidenceRoot,'simulation','cc-result.json'),'CC 专项 JSON')].join(' · ');
const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memo 全功能验收表</title>
<style>
:root{color-scheme:light;--ink:#20272d;--muted:#66717a;--line:#dce1e4;--surface:#f5f7f8;--green:#176045;--amber:#89590e;--red:#a12d31;--purple:#65508d}*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65}main{max-width:1600px;margin:auto;padding:36px 30px 64px}h1{font-size:28px;margin:0 0 8px;letter-spacing:-.5px}h2{font-size:19px;margin:0}h3{font-size:15px;margin:0}p{margin:8px 0}a{color:#215d88;text-underline-offset:3px}small{display:block;font-size:12px;color:var(--muted);font-weight:400;line-height:1.55;margin-top:4px}.meta,.muted{color:var(--muted);font-size:12px}.intro{max-width:1080px}.note{padding:14px 18px;border:1px solid var(--line);border-left:4px solid #6f8293;background:var(--surface);margin:20px 0}.attention{border-left-color:#be8a2d;background:#fffbf2}.danger{border-left-color:var(--red);background:#fff6f6}.summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0}.summary-card{border:1px solid var(--line);border-radius:6px;padding:16px 18px}.summary-card h2{font-size:17px}.summary-card h2 span{font-size:12px;font-weight:400;color:var(--muted);margin-left:7px}.summary-card p{font-size:13px}.summary-card strong{font-weight:600;margin-right:7px}.filters{display:flex;align-items:end;gap:14px;flex-wrap:wrap;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:6px;margin:22px 0 12px;position:sticky;top:0;z-index:3}.filters label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}input,select,button{font:inherit;color:var(--ink);padding:7px 10px;border:1px solid #c7cfd5;border-radius:4px;background:white}input{min-width:240px}button{cursor:pointer}.legend{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 22px}.badge{display:inline-flex;align-items:center;white-space:nowrap;font-size:12px;font-weight:600;border-radius:4px;padding:3px 7px;background:#edf0f2;color:#57636d}.badge.passed{color:var(--green);background:#eaf5ef}.badge.passed.api{color:#215d88;background:#edf4fa}.badge.simulation{color:var(--purple);background:#f1edf8}.badge.failed{color:var(--red);background:#fceeee}.badge.blocked{color:var(--amber);background:#fff1d6}.badge.running{color:#215d88;background:#e9f2fc}.section{margin:34px 0}.section-head{margin-bottom:12px}.section-head p{max-width:1150px;color:var(--muted);font-size:13px}.table-wrap{border:1px solid var(--line);border-radius:6px;overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:11px 12px;vertical-align:top}thead th{background:var(--surface);font-weight:600;white-space:nowrap}tbody th{font-weight:500}tbody tr:last-child>*{border-bottom:0}.matrix{min-width:1120px;table-layout:fixed}.matrix th:first-child{width:30%}.matrix thead th:last-child{width:18%}.matrix td:not(.evidence){text-align:center}.matrix thead th:not(:first-child):not(:last-child){text-align:center}.status-link{text-decoration:none;display:inline-block}.status-link:hover .badge{outline:1px solid currentColor}.row-number{display:inline-block;min-width:25px;color:#7a8791;font-size:11px;margin-right:6px}details{font-weight:400;margin:3px 0}summary{cursor:pointer;color:#335b77;font-size:12px}details[open]>summary{margin-bottom:8px}details details{padding:8px 0;border-top:1px solid var(--line)}pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;background:#f5f7f8;border:1px solid #e3e7ea;padding:10px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:330px;overflow:auto}details p{font-size:12px;overflow-wrap:anywhere}.evidence-links{display:flex;gap:5px;flex-wrap:wrap}.empty{padding:24px;color:var(--muted)}.source-links{overflow-wrap:anywhere;font-size:12px}.jump{display:flex;flex-wrap:wrap;gap:16px;font-size:13px}.footer{border-top:1px solid var(--line);padding-top:18px;margin-top:36px;color:var(--muted);font-size:12px}[hidden]{display:none!important}@media(min-width:1300px){.summary-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:700px){main{padding:22px 14px 40px}h1{font-size:24px}.summary-grid{grid-template-columns:1fr}.filters{position:static;gap:10px}input{min-width:190px}.filters label{flex:1}.section{margin-top:28px}}@media print{main{max-width:none;padding:0}.filters,.jump{display:none}.table-wrap{overflow:visible}.matrix{min-width:0;table-layout:auto}a{color:inherit}.summary-grid{grid-template-columns:repeat(2,1fr)}.section{break-before:auto}thead{display:table-header-group}tr{break-inside:avoid}}
.badge.issue{color:var(--red);background:#fff0e3}
.section{scroll-margin-top:110px}.visual-warning{display:block;color:var(--red);font-size:12px;margin-top:5px}@media(max-width:700px){.section{scroll-margin-top:10px}}
.meta{overflow-wrap:anywhere}
</style></head><body><main>
<h1>Memo 全功能验收表</h1>
<p class="meta">报告快照：${date(generatedAt)}（北京时间） · 执行数据来自本仓库证据文件</p>
<div class="note attention" id="current-availability"><strong>Trae 入口已暂时关闭，保留适配代码。</strong><p>当前应用只可选择 Claude Code、Codex、CodeBuddy。旧 Trae 偏好会依次回退到已安装的 Codex、CodeBuddy、Claude Code；其他三种偏好保持不变。${link(path.join(project,'backups','trae-cli-adapter-2026-11-23.zip'),'关闭前适配代码备份')}</p><p>下方 45 项矩阵和真实 CLI 界面表保留入口关闭前的历史测试快照。关闭后的入口、回退与三助手回归单独记录，历史勾号不作为关闭后的复验结果。</p></div>
<p class="intro">历史测试按助手分别记录。Codex、Trae、CodeBuddy 的 AI 行只接受真实 CLI 与真实模型结果；CC 使用模拟 CLI 与模拟模型。所有测试使用虚构记录和独立临时数据库，不读取或修改实际手帐。</p>
<div class="note"><strong>如何看勾号</strong><p>主矩阵中“通用 API”表示在对应助手设置下实际执行了 HTTP/数据库断言，并未调用模型；它不代表界面按钮已经验收。真实渲染器的界面操作见下方“通用 UI”。CC 模拟、确定性异常测试、模拟流式事件单独标记，不能替代真实模型质量或真实账号可用性。</p></div>
${blocked.length?`<div class="note attention"><strong>历史矩阵中 ${blocked.length} 个真实 AI 项目受阻，未打勾。</strong><p>${esc([...new Set(blocked.map(row=>row.provider.label))].join('、'))} 当时的受阻原因详见每项证据。当前 Trae 选择和运行入口已关闭，历史受阻记录保持原状。</p>${blocked.some(row=>row.provider.id==='trae')?'<p><strong>Trae：</strong>'+esc(traeRestriction)+' '+traeOfficialLinks+'</p>':''}</div>`:''}
${failed?`<div class="note danger"><strong>现有记录中有 ${failed} 项失败。</strong><p>失败保留原状态和日志；本报告不会用其他列的成功补齐。</p></div>`:''}
${visualIssues?`<div class="note attention"><strong>实际截图复查发现 ${visualIssues} 项视觉问题。</strong><p>功能生成与保存的断言结果独立保留；截图中的可读性问题见“视觉复查”，没有标为完全视觉通过。</p></div>`:''}
${warnings.length?`<div class="note danger"><strong>证据读取异常</strong>${warnings.map(value=>`<p>${esc(value)}</p>`).join('')}</div>`:''}
<div class="summary-grid">${providers.map(providerCard).join('')}</div>
<nav class="jump" aria-label="报告目录"><a href="#trae-closure">关闭后的复验</a><a href="#matrix">历史功能矩阵</a><a href="#real-ui">真实 CLI 界面验收</a><a href="#visual-review">视觉复查</a><a href="#common-ui">通用 UI</a><a href="#supplemental">UI 补充与容错</a><a href="#fix-retests">修复与复验</a><a href="#regression">通用回归</a><a href="#cc-special">CC 专项模拟</a><a href="#uncovered">尚未覆盖</a></nav>
<div class="filters"><label>搜索功能或编号<input id="search" type="search" placeholder="例如：图谱、备份、wish_pool"></label><label>范围<select id="scope"><option value="all">全部</option><option value="closure">关闭后的复验</option><option value="ai">AI 功能矩阵</option><option value="common">通用 API 矩阵</option><option value="real-ui">真实 CLI 界面验收</option><option value="visual">真实 UI 视觉复查</option><option value="ui">通用 UI 与补充</option><option value="repair">修复与真实复验</option><option value="regression">通用回归</option><option value="cc">CC 专项模拟</option><option value="uncovered">尚未覆盖</option></select></label><label>状态<select id="status"><option value="all">全部</option><option value="attention">待处理：问题 / 失败 / 受阻 / 未测 / 进行中</option><option value="failed">失败</option><option value="issue">发现视觉问题</option><option value="blocked">受阻</option><option value="running">进行中</option><option value="not_tested">未测</option><option value="passed">通过（含明确标记的模拟 / API）</option></select></label><button id="reset" type="button">重置</button><span id="filter-count" class="meta" aria-live="polite"></span></div>
<div class="legend">${badge('passed')}${badge('passed','api')}${badge('passed','simulation')}${badge('failed')}${badge('issue')}${badge('blocked')}${badge('running')}${badge('not_tested')}</div>
${closureSection()}
<section id="matrix" class="section"><div class="section-head"><h2>入口关闭前功能快照 · ${cases.length} 项</h2><p>每列独立取证；点击状态或“查看各列证据”可展开记录、耗时与原始 JSON/日志。本报告为快照，执行中的用例只显示进行中。</p></div><div class="table-wrap"><table class="matrix"><thead><tr><th scope="col">功能</th><th scope="col">Codex<small>真实 CLI</small></th><th scope="col">Trae<small>历史记录 · 入口已关闭</small></th><th scope="col">CodeBuddy<small>真实 CLI</small></th><th scope="col">CC<small>模拟 CLI / 模拟模型</small></th><th scope="col">证据与限制</th></tr></thead><tbody>${matrix()}</tbody></table></div></section>
<section id="real-ui" class="section"><div class="section-head"><h2>入口关闭前真实 CLI 界面验收 · ${realUiCatalog.length} 项功能</h2><p>这里必须实际点击 Memo 界面并调用该助手的真实 CLI / 真实模型；截图使用虚构记录。此表独立于主矩阵的接口用例，也独立于下方模拟回答的 UI 回归。</p>${realUiSummary()}</div><div class="table-wrap"><table class="real-ui-matrix"><thead><tr><th>功能</th>${realUiProviders.map(provider=>`<th>${esc(provider.label)}<small>真实界面 / 真实 CLI</small></th>`).join('')}<th>证据与截图</th></tr></thead><tbody>${realUiTable()}</tbody></table></div></section>
<section id="visual-review" class="section"><div class="section-head"><h2>真实 UI 截图视觉复查</h2><p>直接复查真实 CLI 界面测试留下的截图。功能断言与视觉可读性分别记录；发现问题的截图不以生成成功代替视觉通过。</p></div><div class="table-wrap"><table><thead><tr><th>助手 / 复查项目</th><th>结果</th><th>发现与实际截图</th></tr></thead><tbody>${visualTable()}</tbody></table></div>${graphRetestTable()}</section>
<section id="common-ui" class="section"><div class="section-head"><h2>入口关闭前通用 UI · ${uiRows.length} 项</h2><p>实际 Electron 渲染器中的控件操作，连接隔离 HTTP 后端；不调用真实模型。书籍和部分异常场景使用模拟 CLI 或注入事件，具体范围逐行说明。${esc(countLabel(uiRows))}。本轮${uiFinishedAt?'结束':'尚未结束'}时间：${date(uiFinishedAt||common?.startedAt)}。</p><p>${link(commonFile,'原始 UI 报告')}${uiEdges?' · '+link(uiEdgesFile,'补充 UI 报告'):''} · ${link(path.join(evidenceRoot,'common','common-ui.log'),'执行日志')} · ${link(path.join(evidenceRoot,'common','common-ui-server.log'),'服务日志')}</p></div><div class="table-wrap"><table><thead><tr><th>功能</th><th>结果</th><th>方式与证据</th></tr></thead><tbody>${uiTable()}</tbody></table></div></section>
<section id="supplemental" class="section"><div class="section-head"><h2>入口关闭前 UI 补充与流式容错</h2><p>这些脚本确实操作渲染器，但模型回答或网络事件是模拟数据；这里的勾号不代表真实模型测试。每行取自相应脚本的完成断言。</p><p>${link(uiSmokeFile,'三组 UI 脚本汇总 JSON')}${uiSmoke?.completedAt?' · 完成 '+date(uiSmoke.completedAt):''}</p>${logNotes.map(note=>`<div class="note attention"><strong>${esc(note.label)}</strong><p>${esc(note.detail)} ${link(note.file,'查看日志')}</p></div>`).join('')}</div><div class="table-wrap"><table><thead><tr><th>功能</th><th>结果</th><th>模拟范围与证据</th></tr></thead><tbody>${supplementalTable()}</tbody></table></div></section>
${codebuddyFixSection()}
<section id="regression" class="section"><div class="section-head"><h2>通用回归 · ${suiteRows.length} 条断言记录</h2><p>存储、迁移、日期、异常及 CLI 协议回归。使用临时数据与模拟 CLI，不调用真实模型。${esc(countLabel(suiteRows))}。执行时间：${date(suite?.finishedAt||suite?.startedAt)}。</p><p>${link(path.join(evidenceRoot,'simulation','suite-result.json'),'完整 JSON')} · ${link(path.join(evidenceRoot,'simulation','suite.log'),'测试日志')} · ${link(path.join(evidenceRoot,'simulation','suite-events.jsonl'),'测试事件 JSONL')}</p></div><div class="table-wrap"><table><thead><tr><th>分组 / 原始断言名称</th><th>结果</th><th>耗时与源码</th></tr></thead><tbody>${regressionTable()}</tbody></table></div></section>
<section id="cc-special" class="section"><div class="section-head"><h2>CC 专项模拟 · ${cc?.rows?.length||0} 项</h2><p>本机没有 Claude Code CLI。这里使用可控的模拟进程验证应用的输入传递、流式输出、保存、失败与恢复；不评价真实 Claude 模型。${esc(countLabel(cc?.rows||[]))}。</p><p>${link(path.join(evidenceRoot,'simulation','cc-result.json'),'完整 JSON')} · ${link(path.join(evidenceRoot,'simulation','cc.log'),'执行日志')} · ${link(path.join(evidenceRoot,'simulation','cc-model-calls.jsonl'),'模拟调用记录')}</p></div><div class="table-wrap"><table><thead><tr><th>功能</th><th>结果</th><th>耗时与模拟证据</th></tr></thead><tbody>${ccTable()}</tbody></table></div></section>
<section id="uncovered" class="section"><div class="section-head"><h2>尚未记录独立验收证据</h2><p>以下项目没有使用相关 API 或其他功能的成功结果代替打勾。模型列中的受阻项目仍以主矩阵为准。</p></div><div class="table-wrap"><table><thead><tr><th>功能 / 环境</th><th>状态</th><th>限制</th></tr></thead><tbody>${omissionsTable()}</tbody></table></div>${notApplicable()}</section>
<footer class="footer"><p>状态完全来自本轮证据文件；未执行、受阻和模拟结果保持区分。未合并历史失败截图来覆盖当前结果。</p><p class="source-links">${sourceLinks}</p><p>刷新报告：<code>node test/render-acceptance-report.js</code>（仅重新读取证据并生成 HTML，不运行测试）。</p></footer>
</main><script>
const fields=['search','scope','status'].map(id=>document.getElementById(id));
const rows=[...document.querySelectorAll('.filterable')];
function filter(){const [query,scope,status]=fields.map(field=>field.value.toLowerCase().trim());let visible=0;for(const row of rows){const states=row.dataset.status.split(' ');const matchedStatus=status==='all'||(status==='attention'?states.some(value=>value!=='passed'):status==='not_tested'?states.some(value=>['not_tested','unverified','skipped'].includes(value)):states.includes(status));const show=(!query||row.dataset.search.includes(query))&&(scope==='all'||row.dataset.scope===scope)&&matchedStatus;row.hidden=!show;if(show)visible++;}document.getElementById('filter-count').textContent='显示 '+visible+' / '+rows.length+' 行';}
for(const field of fields)field.addEventListener(field.id==='search'?'input':'change',filter);
document.getElementById('reset').addEventListener('click',()=>{fields[0].value='';fields[1].value='all';fields[2].value='all';filter();});
document.addEventListener('click',event=>{const anchor=event.target.closest('a[href^="#detail-"]');if(!anchor)return;const target=document.getElementById(anchor.getAttribute('href').slice(1));if(target){let element=target;while(element){if(element.tagName==='DETAILS')element.open=true;element=element.parentElement;}}});
filter();
</script></body></html>`;
fs.writeFileSync(output,html);
console.log(JSON.stringify({report:path.relative(project,output),matrixCases:cases.length,closureUiChecks:closureUiRows.length,closureAdditionalChecks:closureExtraRows.length,realUiFeatures:realUiCatalog.length,realUi:realUiProviders.map(provider=>({agent:provider.id,...counts(realUiCatalog.map(item=>realUiRecord(provider,item.id)))})),uiChecks:uiRows.length,supplementalUiChecks:supplemental.length,regressionChecks:suiteRows.length,ccSimulationChecks:cc?.rows?.length||0,visualChecks:visualRows.length,visualIssues,graphRetests:graphRetestRows.map(row=>({provider:row.provider,status:row.status})),realAiBlocked:blocked.length,failedRecords:failed,generatedAt},null,2));
