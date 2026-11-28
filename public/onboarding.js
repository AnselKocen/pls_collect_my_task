(() => {
  'use strict';
  const guide = document.getElementById('guideModal');
  const readiness = document.getElementById('agentReadinessModal');
  if (!guide || !readiness) return;
  const DISMISSED_KEY = 'memo:agent-readiness:dismissed';
  const names = {cc:'Claude Code',codex:'Codex',codebuddy:'CodeBuddy'};
  const labels = {missing:'本机未检测到 CLI',logged_out:'本机未检测到 CLI 登录状态',detected:'已检测到登录状态，尚未测试连接',unknown:'已检测到 CLI，登录状态未确认'};
  let snapshot = null, active = null, opener = null, busy = false;
  let started = false, refreshing = false, testing = null, poll = null;
  let requestSequence = 0, closedWhileLoading = false, reconnecting = null;
  function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function write(key,value) { try { localStorage.setItem(key,value); } catch {} }
  function visible(modal) { return !modal.classList.contains('hidden'); }
  function errorText(text='') {
    const el=document.getElementById('readinessError');
    el.textContent=text;el.classList.toggle('hidden',!text);
  }
  function show(modal) {
    if (!active) opener=document.activeElement;
    guide.classList.add('hidden');readiness.classList.add('hidden');
    active=modal;modal.classList.remove('hidden');document.body.classList.add('onboarding-open');
    modal.querySelector('[role="dialog"]').focus({preventScroll:true});
  }
  function dismissDetection() {
    if (snapshot?.serviceId) write(DISMISSED_KEY,snapshot.serviceId);
    else closedWhileLoading=true;
    readiness.classList.add('hidden');active=null;document.body.classList.remove('onboarding-open');
    if (opener?.isConnected && opener !== document.body) opener.focus({preventScroll:true});
    else document.getElementById('btnHelp').focus({preventScroll:true});
  }
  function closeGuide() {
    show(readiness);document.getElementById('readinessGuideOpen').focus({preventScroll:true});
  }
  function accept(data) {
    if (!data || !Array.isArray(data.agents) || typeof data.serviceId!=='string') throw new Error('助手状态暂时无法读取，请稍后重新检测。');
    snapshot=data;
    if(closedWhileLoading) {write(DISMISSED_KEY,data.serviceId);closedWhileLoading=false;}
    for (const el of document.querySelectorAll('[data-app-version]')) el.textContent=data.version ? 'v'+data.version : '版本暂不可用';
    render();
    clearTimeout(poll);
    if (data.checking || data.agents.some(agent=>agent.test?.state==='running')) poll=setTimeout(() => load(false).catch(() => {}),750);
  }
  function render() {
    const checking=Boolean(snapshot?.checking) || refreshing;
    const rows=snapshot?.agents || Object.entries(names).map(([id,name]) => ({id,name,state:'checking',canTest:false}));
    const container=document.getElementById('readinessAgents');
    // Preserve focused controls while a slow test or status poll completes.
    const focused=document.activeElement?.dataset.testAgent;
    container.replaceChildren();
    for (const agent of rows) {
      if(!Object.hasOwn(names,agent.id))continue;
      const row=document.createElement('div');row.className='readiness-agent';row.dataset.agent=agent.id;row.dataset.readinessAgent=agent.id;row.dataset.state=agent.state;
      const info=document.createElement('div');info.className='readiness-agent-info';
      const name=document.createElement('span');name.className='readiness-agent-name';name.textContent=names[agent.id];
      const state=document.createElement('span');state.className='readiness-agent-state';
      state.textContent=checking ? '正在检查 CLI 与登录状态…' : agent.test?.state==='success' ? '连接成功 · 最近一次手动测试已通过' : agent.state==='unknown' && agent.detail ? agent.detail : labels[agent.state] || '检测状态暂未确认';
      info.append(name,state);row.append(info);
      if(agent.canTest && !checking) {
        const button=document.createElement('button');button.type='button';button.className='btn-small';button.dataset.testAgent=agent.id;
        button.textContent=testing===agent.id || agent.test?.state==='running' ? '测试中…' : agent.test?.state==='success' ? '再次测试' : '测试连接';
        button.disabled=busy || Boolean(testing) || agent.test?.state==='running';
        button.title=busy ? '有 AI 任务正在处理，请完成后再测试' : '发送固定测试消息，可能消耗少量模型额度';
        button.addEventListener('click',() => testAgent(agent.id));row.append(button);
      }
      if(agent.test && ['failed','running','success'].includes(agent.test.state)) {
        const result=document.createElement('p');result.className='readiness-agent-result';result.setAttribute('role','status');
        result.textContent=agent.test.state==='running' ? '正在发送固定测试消息，请稍等…' : agent.test.state==='success' ? '最近一次测试连接成功；实际使用仍取决于网络和账号状态。' : agent.test.message || '暂时无法连接，请检查助手配置或稍后再试。';
        row.append(result);
      }
      container.append(row);
    }
    if(focused && visible(readiness))container.querySelector(`[data-test-agent="${focused}"]`)?.focus({preventScroll:true});
    document.getElementById('readinessRefresh').disabled=checking || Boolean(testing) || busy;
    const summary=document.getElementById('readinessSummary');
    summary.textContent=checking ? '正在检查本机助手…' : snapshot ? '本次服务的基础检测结果' : '尚未取得本机检测结果';
  }
  async function request(path,body) {
    const response=await fetch(path,{method:body===undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json','X-Memo-AI':'1'},signal:AbortSignal.timeout(path.endsWith('/test') ? 35000 : 20000),...(body===undefined ? {} : {body:JSON.stringify(body)})});
    const data=await response.json().catch(() => ({}));
    if(!response.ok)throw new Error(data.error || '助手检测暂时无法连接，请稍后重试。');
    return data;
  }
  async function load(refresh=false) {
    const sequence=++requestSequence;
    if(refresh){refreshing=true;render();}
    try {
      const data=await request('/api/ai/readiness'+(refresh ? '/refresh' : ''),refresh ? {} : undefined);
      if(sequence===requestSequence){refreshing=false;accept(data);errorText();}
      return data;
    } catch(error) {
      if(sequence===requestSequence){refreshing=false;clearTimeout(poll);if(snapshot)snapshot={...snapshot,checking:false};render();errorText(error.name==='TimeoutError' ? '本机检测暂时没有响应，可以稍后重新检测。' : error.message);}
      throw error;
    }
  }
  async function testAgent(id) {
    if(testing || refreshing || busy || !snapshot?.agents.some(agent => agent.id===id && agent.canTest))return;
    clearTimeout(poll);++requestSequence;
    testing=id;errorText();render();
    try { accept(await request('/api/ai/readiness/test',{agent:id})); }
    catch(error) { await load(false).catch(() => {});errorText(error.message); }
    finally {testing=null;render();}
  }
  function openHelp() {
    closedWhileLoading=false;show(readiness);
    if(!snapshot || !testing)load(false).catch(() => {});
  }
  function openGuide() {show(guide);}
  async function start() {
    if(started)return;started=true;
    render();
    try {
      const data=await load(false);
      if(read(DISMISSED_KEY)!==data.serviceId && !active)show(readiness);
    } catch {
      for(const el of document.querySelectorAll('[data-app-version]'))el.textContent='版本暂不可用';
      if(!active && !closedWhileLoading)show(readiness);
    }
  }
  document.getElementById('btnHelp').addEventListener('click',openHelp);
  document.getElementById('readinessGuideOpen').addEventListener('click',openGuide);
  const legacyGuide=document.getElementById('btnGuide');
  legacyGuide?.addEventListener('click',openHelp);
  if(legacyGuide){legacyGuide.setAttribute('role','button');legacyGuide.tabIndex=0;legacyGuide.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();openHelp();}});}
  document.getElementById('guideClose').addEventListener('click',closeGuide);
  document.getElementById('guideOk').addEventListener('click',closeGuide);
  document.getElementById('agentReadinessClose').addEventListener('click',dismissDetection);
  document.getElementById('agentReadinessOk').addEventListener('click',dismissDetection);
  document.getElementById('readinessRefresh').addEventListener('click',() => load(true).catch(() => {}));
  for(const modal of [guide,readiness])modal.addEventListener('click',event=>{if(event.target===modal)(modal===guide ? closeGuide : dismissDetection)();});
  document.addEventListener('keydown',event=>{
    if(!active || !visible(active))return;
    if(event.key==='Escape') {event.preventDefault();(active===guide ? closeGuide : dismissDetection)();}
    else if(event.key==='Tab') {
      const items=[...active.querySelectorAll('button:not(:disabled),a[href],[tabindex="0"]')].filter(el=>el.getClientRects().length);
      if(!items.length)return;
      const index=items.indexOf(document.activeElement);
      if(event.shiftKey && index<=0){event.preventDefault();items.at(-1).focus();}
      else if(!event.shiftKey && (index<0 || index===items.length-1)){event.preventDefault();items[0].focus();}
    }
  });
  window.MemoOnboarding=Object.freeze({start,open:openHelp,updateAIStatus(status){
    busy=Boolean(status.busy || status.maintenance);if(snapshot)render();
    if(started && snapshot && status.serviceId && status.serviceId!==snapshot.serviceId && reconnecting!==status.serviceId) {
      reconnecting=status.serviceId;
      load(false).then(data=>{if(read(DISMISSED_KEY)!==data.serviceId && !visible(guide))show(readiness);}).catch(()=>{}).finally(()=>{reconnecting=null;});
    }
  }});
})();
