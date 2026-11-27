(function () {
  const el = id => document.getElementById(id);
  const wizard = el('habitWishWizard'), entry = el('habitWishStart');
  const input = el('habitWishInput');
  const parent = el('tagSummaryModal'), parentContent = parent.querySelector('.modal-content');
  const dialog = wizard.querySelector('[role="dialog"]');
  const viewedPoolIds = new Set();
  let returnFocus = entry;
  let state = fresh();

  function fresh() {
    return { step: 'wish', wish: '', purpose: '', effort: '', requestId: null, messages: [{ role: 'assistant', text: '你最近想做什么，或者改变什么？' }], current: null, options: [], other: false, pending: false, error: '', status: '', pool: null };
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);element.className = className;element.textContent = text;return element;
  }
  function render() {
    const focusWasInside = dialog.contains(document.activeElement);
    const unseenPool = Boolean(state.pool && !viewedPoolIds.has(state.pool.id));
    const labels = { wish: '1 / 3 · 一个愿望', purpose: '2 / 3 · 期待的变化', effort: '3 / 3 · 适合你的投入', generate: '正在准备你的卡池', done: unseenPool ? '你的愿望，变成了30张小卡片' : '本次对话记录' };
    el('habitWishStep').textContent = labels[state.step];
    const messages = el('habitWishMessages');messages.replaceChildren();
    for (const message of state.messages) {
      const bubble = node('p', 'habit-wish-message ' + message.role, message.text || '正在想一想…');
      if (message === state.current) { bubble.dataset.current = '';bubble.setAttribute('aria-live', 'polite'); }
      messages.append(bubble);
    }
    messages.scrollTop = messages.scrollHeight;
    el('habitWishStatus').textContent = state.status;
    el('habitWishStatus').classList.toggle('is-pending', state.pending);
    const options = el('habitWishOptions');options.replaceChildren();
    if (!state.pending && !state.error && state.options.length) {
      [...state.options, '其他，我来补充。'].forEach((text, index) => {
        const button = document.createElement('button');button.type = 'button';button.className = 'habit-wish-option';
        button.append(node('span', 'habit-wish-option-number', String(index + 1)), node('span', '', text));
        if (index === 3) button.setAttribute('aria-expanded', String(state.other));
        button.addEventListener('click', () => choose(index));options.append(button);
      });
    }
    el('habitWishForm').classList.toggle('hidden', state.pending || state.error !== '' || !(state.step === 'wish' || state.other));
    el('habitWishInputLabel').textContent = state.step === 'wish' ? '你的计划' : '补充你的想法';
    input.placeholder = state.step === 'wish' ? '比如学英语、整理房间、开始画画…' : '写下更符合你的想法…';
    el('habitWishSubmit').textContent = state.step === 'wish' ? '聊聊这个计划' : '提交补充';
    el('habitWishSubmit').disabled = state.pending;
    el('habitWishError').classList.toggle('hidden', !state.error);
    el('habitWishErrorText').textContent = state.error;
    el('habitWishSuccess').classList.toggle('hidden', !unseenPool);
    el('habitWishRestart').disabled = state.pending;
    const generating = state.pending && state.step === 'generate';
    const progress = el('habitWishProgress');
    progress.classList.toggle('hidden', !generating && !state.error && !unseenPool);
    progress.classList.toggle('is-generating', generating);
    progress.classList.toggle('is-error', Boolean(state.error));
    progress.classList.toggle('is-complete', unseenPool);
    el('habitWishProgressTitle').textContent = generating ? '正在生成习惯卡池' : state.error ? state.step === 'generate' ? '这次生成需要再试一下' : '对话暂时停了一下' : '专属习惯卡池已准备好';
    el('habitWishProgressText').textContent = generating ? '正在把你的计划整理成30张小卡片，可以先做点别的。' : state.error ? state.error : '30张小习惯，陪你从今天开始。';
    el('habitWishResume').textContent = state.pool ? '查看卡池' : state.error ? '返回对话重试' : '查看对话';
    if (focusWasInside && !wizard.classList.contains('hidden') && (!dialog.contains(document.activeElement) || !document.activeElement.getClientRects().length)) {
      el('habitWishHide').focus();
    }
  }

  function open() {
    if (parent.classList.contains('hidden')) return;
    returnFocus = document.activeElement instanceof HTMLElement && parent.contains(document.activeElement) ? document.activeElement : entry;
    wizard.classList.remove('hidden');render();
    if (state.step === 'wish' && !state.pending) input.focus();
    else el('habitWishHide').focus();
    parentContent.inert = true;parentContent.setAttribute('aria-hidden', 'true');
  }
  function close(restoreFocus = true) {
    const wasOpen = !wizard.classList.contains('hidden');
    wizard.classList.add('hidden');parentContent.inert = false;parentContent.removeAttribute('aria-hidden');
    if (wasOpen && restoreFocus && !parent.classList.contains('hidden')) {
      (returnFocus?.isConnected ? returnFocus : entry).focus();
    }
  }
  function viewPool() {
    if (!state.pool) return;
    close();showHabitPoolDetail(state.pool.id);
  }
  function markViewed(poolId) {
    if (typeof poolId !== 'string' || !poolId) return;
    // A task can open its saved pool before this request's final response is
    // read. Remember the ID now so that late response cannot revive the notice.
    viewedPoolIds.add(poolId);
    window.markAITaskDestinationViewed?.(poolId);
    if (state.pool?.id === poolId) render();
  }

  function choose(index) {
    if (state.pending || state.error || !state.options.length) return;
    if (index === 3) { state.other = true;render();input.focus();return; }
    answer(state.options[index]);
  }
  function answer(text) {
    state.messages.push({ role: 'user', text });
    state.options = [];state.other = false;input.value = '';
    if (state.step === 'wish') { state.wish = text;void run('purpose'); }
    else if (state.step === 'purpose') { state.purpose = text;void run('effort'); }
    else if (state.step === 'effort') {
      state.effort = text;state.requestId = crypto.randomUUID();void run('generate');
    }
  }
  function userError(message) { const error = new Error(message);error.userFacing = true;return error; }

  async function readStream(response, onEvent) {
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await response.json();
      if (!response.ok) throw userError(window.memoMessages.errorMessage(data.error, settings.agent));
      return data;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', result;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (!event || !data) continue;
          const payload = JSON.parse(data);
          if (event === 'error') throw userError(payload.error);
          if (event === 'result') result = payload;
          else onEvent(event, payload);
        }
        if (done) break;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!result) throw userError('连接暂时中断了，回答还在。点“再试一次”继续吧～');
    return result;
  }

  async function run(stage, retry = false) {
    if (state.pending) return;
    state.pending = true;state.step = stage;state.error = '';state.other = false;
    state.status = stage === 'generate' ? '正在为你整理30张习惯卡…' : '正在想一个适合你的问题…';
    if (stage !== 'generate' && !retry) {
      state.current = { role: 'assistant', text: '' };state.messages.push(state.current);
    }
    if (retry && state.current && stage !== 'generate') state.current.text = '';
    render();
    const task = stage === 'generate' ? '生成愿望卡池' : stage === 'purpose' ? '明确愿望的目的' : '选择习惯的投入方式';
    let started = false, success = false;
    try {
      if (await checkCCAvailable()) throw userError('请先在设置中连接所选 AI 助手，再回来继续吧～');
      showCCTask(task, { type:stage === 'generate' ? 'habit-pool' : 'habit-wish', source:'wish', step:stage });started = true;
      const response = await fetch('/api/habit/wish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, wish: state.wish, purpose: state.purpose, effort: state.effort, requestId: state.requestId })
      });
      // Receiving the accepted generation response is the point at which the
      // conversation can shrink back into the parent pool's progress card.
      if (stage === 'generate' && response.ok) close();
      const result = await readStream(response, (event, data) => {
        if (event === 'question' && state.current) { state.current.text = data.text;state.status = '正在整理回答选项…'; }
        else if (event === 'status') state.status = data.text;
        render();
      });
      if (stage === 'generate') {
        if (!result.pool) throw new Error('AI 结果校验：缺少卡池');
        state.pool = result.pool;state.step = 'done';
        window.setAITaskNavigationResult?.(task, { type:'habit-pool', source:'wish', step:'generate', id:result.pool.id, generatedAt:result.pool.createdAt });
        await loadHabitPools();showToast('🎉 你的愿望卡池生成了～');
      } else {
        state.current.text = result.question;state.options = result.options;
      }
      success = true;
    } catch (error) {
      console.error('[Habit wish]', error);
      state.error = error.userFacing ? error.message : error instanceof TypeError ? '连接暂时中断了，回答还在。点“再试一次”继续吧～' : window.memoMessages.errorMessage(error.message, settings.agent);
    } finally {
      if (started) hideCCTask(task, success);
      state.pending = false;state.status = '';render();
    }
  }

  entry.addEventListener('click', open);
  el('habitWishHide').addEventListener('click', () => close());
  el('habitWishResume').addEventListener('click', () => state.pool ? viewPool() : open());
  wizard.addEventListener('click', event => { if (event.target === wizard) close(); });
  document.addEventListener('keydown', event => {
    if (wizard.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();close();return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(control => control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault();dialog.focus();return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault();last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault();first.focus(); }
  });
  document.addEventListener('focusin', () => {
    if (!wizard.classList.contains('hidden') && !dialog.contains(document.activeElement)) el('habitWishHide').focus();
  });
  // Backdrop closing is shared by the app's modals. Observe the parent so both
  // that path and its close button consistently dismiss the second layer.
  new MutationObserver(() => {
    if (parent.classList.contains('hidden')) close(false);
  }).observe(parent, { attributes: true, attributeFilter: ['class'] });
  el('habitWishForm').addEventListener('submit', event => {
    event.preventDefault();if (state.pending || state.error) return;
    const text = input.value.trim();if (!text) { input.focus();return; }answer(text);
  });
  el('habitWishRetry').addEventListener('click', () => { void run(state.step, true); });
  el('habitWishRestart').addEventListener('click', () => {
    if (state.pending) return;state = fresh();input.value = '';render();input.focus();
  });
  el('habitWishView').addEventListener('click', viewPool);
  window.habitWishDialog = { close, open, markViewed };
  render();
})();
