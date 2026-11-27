// === State ===
let allTags = [];
let selectedTags = [];
let settings = {};
let memos = [];
let filteredMemos = null;

const TAG_COLORS = 6;
const DECORS = ['🌿', '🌸', '🐱', '🍂', '✨', '🌻', '🌷', '☘️', '🦋', '🐝'];
const TAPES = ['tape-1','tape-2','tape-3','tape-4','tape-5','tape-6','tape-7','tape-8','tape-9','tape-10'];
const PAPERS = ['paper-cream','paper-grid','paper-plain','paper-kraft'];

function hash(s){let h=0;for(let i=0;i<s.length;i++)h=((h<<5)-h+s.charCodeAt(i))|0;return Math.abs(h);}

const EMOJI_GROUPS = {
  '文具': ['🏷️','📖','🖊️','✏️','📜','🗂️','📋','🖇️','📎','💡','⏳'],
  '星光': ['✨','🌟','💫','⭐','☄️','🪄','🔮','💎'],
  '天气': ['☁️','☀️','🌙','⛈️','❄️','🌈','🌊','🪐','🌤️','🎐'],
  '植物': ['🌷','🌸','🌼','🌻','🍀','🌿','🍃','🌵','🌾','🍄','🌹'],
  '美食': ['🍓','🍒','🍑','🍇','🍋','🍦','🍰','🍩','🍪','🍮','🍬','🍭','🍯','🍵','🍹','🧁'],
  '生活': ['🎀','🎈','🧸','🩰','💄','💍','💌','🕯️','🎨','📚','🖋️','🧺','🪞','🛁','🧼','🧶'],
  '爱心': ['💖','💗','💓','💞','💘','💝','💟','❣️','🧡','💛','💚','💙','💜','🤎','🖤','🤍'],
  '动物': ['🐾','🐱','🐰','🐣','🐥','🦋','🐝','🦄','🐧','🐼','🐨','🦁','🦢','🐙','🐚','🐌']
};

function tagColorIndex(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  return Math.abs(hash) % TAG_COLORS;
}

function randomDecor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return DECORS[Math.abs(hash) % DECORS.length];
}

function getTagEmoji(tag) {
  return (settings.tagEmojis && settings.tagEmojis[tag]) || '🏷️';
}

function getTagTape(tag) {
  return (settings.tagTapes && settings.tagTapes[tag]) || TAPES[hash(tag) % TAPES.length];
}

const TAPE_LABELS = ['黄格子','淡鹅黄','淡黄格子','深棕格子','白底横纹','白底波点','明黄格子','纯棕色','小花','白底爱心'];

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function compareMemoDisplayOrder(a, b) {
  const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinned) return pinned;
  if (a.pinned) {
    const aOrder = Number.isInteger(a.initialOrder) && a.initialOrder >= 0 && a.initialOrder < 6 ? a.initialOrder : 6;
    const bOrder = Number.isInteger(b.initialOrder) && b.initialOrder >= 0 && b.initialOrder < 6 ? b.initialOrder : 6;
    if (aOrder !== bOrder) return aOrder - bOrder;
  }
  return new Date(b.createdAt) - new Date(a.createdAt);
}

function requestError(detail,path,status) {
  console.error('[Request]',{path,status,detail});
  const error=new Error(window.memoMessages.errorMessage(detail,settings.agent || 'cc'));
  error.detail=detail;error.status=status;
  return error;
}

let ccOperationSequence = 0;
function beginCatMutation(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (!['POST','PUT','DELETE'].includes(method)) return null;
  let body = {};
  try { if (typeof options.body === 'string') body = JSON.parse(options.body); } catch {}
  if (!body || typeof body !== 'object') body = {};
  const organizing = /^\/api\/(?:memos|tags|scheduled)(?:\/|$)/.test(path)
    || /^\/api\/habit\/(?:pools|log|draw)(?:\/|$)/.test(path) && !path.endsWith('/generate')
    || /^\/api\/cc\/(?:tag-suggestion|graph|weekly-digest)\//.test(path)
    || path === '/api/settings' && ['tagOrder','tagTapes','tagEmojis'].some(key => key in body)
    || /^\/api\/storage\/(?:backup|restore)$/.test(path);
  if (!organizing || !window._ccActivity) return null;
  const id = 'organize:' + ++ccOperationSequence;
  return { id, token:window._ccActivity.begin(id,'sweeping',5) };
}
function finishCatMutation(activity, success) {
  if (activity) window._ccActivity.end(activity.id,activity.token,{success});
}

async function api(path, opts = {}) {
  const activity = beginCatMutation(path,opts);
  try {
    const headers = { 'Content-Type': 'application/json' };
    let res;
    try { res = await fetch(path, { ...opts, headers }); }
    catch(error) { throw requestError(error.message,path,0); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err=requestError(data.error || 'Request failed',path,res.status);
      err.ccBusy=Boolean(data.busy);
      if(err.ccBusy)showToast(err.message);
      throw err;
    }
    const data = await res.json();
    finishCatMutation(activity,!data?.error);
    return data;
  } catch (error) {
    finishCatMutation(activity,false);
    throw error;
  }
}

// The model is ready before async app boot, so early task events are retained.
window._ccCtrl = { stop: () => {}, resume: () => {}, getPos: () => 0, setState: () => {} };
window._ccActivity = window.CCPixelCatController.create({
  onChange(state) { window._ccCtrl.setState(state); }
});
window.addEventListener('cc-task-update',event => receiveCCTask(event.detail.task));


let modalToastTimer = null;
function showModalToast(message) {
  const el = document.getElementById('tagManagerToast');
  el.textContent = message;
  el.classList.remove('hidden', 'fading');
  if (modalToastTimer) clearTimeout(modalToastTimer);
  modalToastTimer = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.classList.add('hidden'), 350);
  }, 1500);
}

// === App Toast ===
let appToastTimer = null;
function showToast(message) {
  const el = document.getElementById('appToast');
  el.textContent = message;
  el.classList.remove('hidden', 'fading');
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.classList.add('hidden'), 400);
  }, 2000);
}

// === Custom Confirm ===
function showConfirm(message, onConfirm) {
  const modal = document.getElementById('confirmModal');
  const parts = message.split('\n');
  const el = document.getElementById('confirmMessage');
  el.innerHTML = parts.map((p, i) => i === 0 ? `<span>${escapeHtml(p)}</span>` : `<span class="confirm-sub">${escapeHtml(p)}</span>`).join('');
  // Clone buttons first to clear any stale listeners from previous calls
  const oldOk = document.getElementById('confirmOk');
  const oldCancel = document.getElementById('confirmCancel');
  const okBtn = oldOk.cloneNode(true);
  const cancelBtn = oldCancel.cloneNode(true);
  oldOk.replaceWith(okBtn);
  oldCancel.replaceWith(cancelBtn);
  modal.classList.remove('hidden');
  const cleanup = () => { modal.classList.add('hidden'); };
  okBtn.addEventListener('click', () => { cleanup(); onConfirm(); }, { once: true });
  cancelBtn.addEventListener('click', cleanup, { once: true });
}

let ccToastTimer = null;
let _ccActiveTasks = 0;
let _ccBubbleRaf = null;
let _ccRemoteTask = null;
function _updateBubblePos() {
  const bubble = document.getElementById('ccTaskBubble');
  const cc = document.querySelector('.cc-container');
  const strip = document.querySelector('.cc-walk-strip');
  if (!bubble || !cc || !strip || bubble.classList.contains('hidden')) return;
  const ccRect = cc.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const ccVisualLeft = ccRect.left - stripRect.left;
  const bubbleW = bubble.offsetWidth || 220;
  bubble.style.left = Math.max(4, ccVisualLeft - bubbleW - 10) + 'px';
  _ccBubbleRaf = requestAnimationFrame(_updateBubblePos);
}
function _showCCBubble(text, isDone) {
  const bubble = document.getElementById('ccTaskBubble');
  if (!bubble) return;
  bubble.title = text;
  if (isDone) {
    bubble.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="cc-task-open" data-ai-task-details>前往查看</button><button class="cc-task-bubble-close" id="ccBubbleClose">✕</button>`;
    document.getElementById('ccBubbleClose').addEventListener('click', () => {
      bubble.classList.add('hidden');
      cancelAnimationFrame(_ccBubbleRaf);
      _scheduleCCIdle();
    });
  } else {
    bubble.innerHTML = `<span>${escapeHtml(text)}</span>`;
  }
  bubble.classList.remove('hidden');
  window.updateAITaskNavigation?.();
  cancelAnimationFrame(_ccBubbleRaf);
  _ccBubbleRaf = requestAnimationFrame(_updateBubblePos);
}

function receiveCCTask(task) {
  const previous = _ccRemoteTask;
  _ccRemoteTask = task ? { id:task.id, status:task.status, stage:task.stage, name:task.name, target:task.target } : null;
  syncHabitMaterialTaskState(task);
  syncAITaskDestinationStatus(task);
  if (task?.status === 'running') {
    const state = window.CCPixelCatController.stateForTask(task);
    for (const [name,token] of _ccTaskTokens) window._ccActivity.update('request:'+name,state,token);
  }
  window._ccActivity.applyTask(task);
  if (task?.status === 'running') {
    clearTimeout(_ccIdleTimer);clearTimeout(_ccIdleHideTimer);
    if (previous?.id !== task.id || previous.status !== task.status || previous.stage !== task.stage || previous.name !== task.name) {
      _showCCBubble(task.stage || '正在' + task.name,false);
    }
  } else if (task && previous?.id === task.id && previous.status === 'running') {
    _showCCBubble(task.status === 'completed' ? '已完成：' + task.name : task.error || '这次没完成，请再试一次',true);
    _scheduleCCIdle();
  }
}

const _CC_IDLE_PHRASES = [
  '记得喝水...',
  '(偷翻便签中)',
  '好多事情..',
  '早点休息..',
  '让我帮你整理一下思绪吧?',
  '麻烦的事情交给我',
  '🎵～',
];
let _ccIdleTimer = null;
let _ccIdleHideTimer = null;
function _scheduleCCIdle() {
  clearTimeout(_ccIdleTimer);
  _ccIdleTimer = setTimeout(() => {
    const bubble = document.getElementById('ccTaskBubble');
    if (!window._ccActivity.isBusy() && window._ccActivity.getState() === 'idle' && bubble && bubble.classList.contains('hidden')) {
      const phrase = _CC_IDLE_PHRASES[Math.floor(Math.random() * _CC_IDLE_PHRASES.length)];
      bubble.innerHTML = `<span>${phrase}</span>`;
      bubble.classList.remove('hidden');
      cancelAnimationFrame(_ccBubbleRaf);
      _ccBubbleRaf = requestAnimationFrame(_updateBubblePos);
      clearTimeout(_ccIdleHideTimer);
      _ccIdleHideTimer = setTimeout(() => {
        if (!window._ccActivity.isBusy()) {
          bubble.classList.add('hidden');
          cancelAnimationFrame(_ccBubbleRaf);
        }
        _scheduleCCIdle();
      }, 2500);
    } else {
      _scheduleCCIdle();
    }
  }, 90000);
}

const _ccTaskSet = new Set();
const _ccTaskTokens = new Map();

function showCCTask(taskName,target) {
  if (_ccTaskSet.has(taskName)) return;
  _ccTaskSet.add(taskName);
  document.querySelectorAll('.ai-destination-note').forEach(note=>{note.textContent='';note.classList.add('hidden');});
  window.markAITaskPending?.(target,taskName);
  renderAgentControl();
  clearTimeout(_ccIdleTimer);
  clearTimeout(_ccIdleHideTimer);
  _ccActiveTasks++;
  _ccTaskTokens.set(taskName,window._ccActivity.begin('request:'+taskName,'thinking',20));
  _showCCBubble('正在' + taskName + ' =(¯꒳¯ )=', false);
}

function hideCCTask(taskName,success=true) {
  if (!_ccTaskSet.has(taskName)) return;
  _ccTaskSet.delete(taskName);
  window.finishAITaskPending?.(taskName,success);
  window._ccActivity.end('request:'+taskName,_ccTaskTokens.get(taskName),{success});
  _ccTaskTokens.delete(taskName);
  renderAgentControl();
  syncAIStatus().catch(() => {});
  _ccActiveTasks = Math.max(0, _ccActiveTasks - 1);
  if (_ccActiveTasks === 0) {
    _showCCBubble(success ? '已完成：' + taskName + '୧(´▽`★)୭!' : '这次没整理好哦～请再试一次吧～', true);
  } else {
    const remaining = [..._ccTaskSet][0];
    if (remaining) _showCCBubble('正在' + remaining + ' =(¯꒳¯ )=', false);
  }
}

// Backend state is authoritative, including cron jobs and other open windows.
let aiState = {agent:'cc',busy:false,maintenance:false,configured:false};
let agentStatusKnown = false;
let agentSwitchPending = false;
let agentStatusSequence = 0;
function taskWaitText(status) {
  const seconds = Math.max(0,Math.floor(Number(status.elapsedMs || 0)/1000));
  const duration = seconds >= 60 ? `${Math.floor(seconds/60)}分${seconds%60}秒` : `${seconds}秒`;
  return `正在处理：${status.task || 'AI任务'} · 已等待${duration}${seconds >= 30 ? '，请稍等' : ''}`;
}
function renderAgentControl() {
  const field = document.getElementById('agentSelect');
  if (!field) return;
  const available=Array.from(field.options,option=>option.value);
  field.value = [settings.agent,aiState.agent,'cc'].find(value=>available.includes(value));
  const working = aiState.busy || _ccTaskSet.size > 0;
  field.disabled = !agentStatusKnown || agentSwitchPending || working || aiState.maintenance;
  const hint = !agentStatusKnown ? '正在确认助手状态…'
    : working ? (aiState.busy ? taskWaitText(aiState)+'；暂时不能切换' : '任务进行中，暂时不能切换')
    : aiState.maintenance ? '正在恢复数据，请稍等'
    : !aiState.configured ? '请先安装并登录所选助手，再使用 AI 功能' : '';
  document.getElementById('agentHint').textContent = hint;
  field.title = hint;
}
async function syncAIStatus() {
  const sequence = ++agentStatusSequence;
  try {
    const status = await api('/api/ai/status');
    if (sequence === agentStatusSequence && !agentSwitchPending) {
      aiState = status;settings.agent = status.agent;agentStatusKnown = true;renderAgentControl();
      window._ccActivity.setBusy(status);
      if (status.busy && window._ccActivity.snapshot().activities.some(activity => activity.id === 'backend-busy')) {
        _showCCBubble(taskWaitText(status),false);
      }
    }
    return status;
  } catch (error) {
    if (sequence === agentStatusSequence && !agentSwitchPending) { agentStatusKnown=false;renderAgentControl(); }
    throw error;
  }
}

async function checkCCAvailable() {
  try {
    const status = await syncAIStatus();
    if (status.configured) return false;
    if (status.busy || status.maintenance) { showToast('正在处理上一项任务，请稍等～');return true; }
    if (window.electronAPI?.setupAgent) {
      const result = await window.electronAPI.setupAgent(status.agent);
      await syncAIStatus();
      if (result.configured) return false;
    }
    showToast(window.memoMessages.errorMessage('AGENT_CLI_MISSING:'+status.agent,status.agent));
  } catch (error) { showToast(window.memoMessages.errorMessage(error.message,settings.agent)); }
  return true;
}

async function checkCCBusy() {
  try {
    const status = await syncAIStatus();
    if (!status.busy && !status.maintenance) return false;
    showToast('正在处理上一项任务，请稍等～');
  } catch (error) { showToast(error.message); }
  return true;
}

document.getElementById('agentSelect').addEventListener('change',async event => {
  const next = event.target.value;
  if (!agentStatusKnown || aiState.busy || aiState.maintenance || _ccTaskSet.size || agentSwitchPending) { renderAgentControl();return; }
  agentSwitchPending = true;++agentStatusSequence;renderAgentControl();
  try {
    settings = await api('/api/settings',{method:'PUT',body:JSON.stringify({agent:next})});
    const name = Array.from(event.target.options).find(option => option.value === next).textContent;
    showToast('AI 助手已切换为 '+name+' ✓');
  } catch (error) { if(!error.ccBusy)showToast(error.message); }
  finally {
    agentSwitchPending = false;
    await syncAIStatus().catch(() => {});
    renderAgentControl();
  }
});

// Compat shims
function showLoading() {}
function hideLoading() {}

// === Init ===
async function init() {
  document.getElementById('app').classList.remove('hidden');
  try {
    [allTags, settings, memos] = await Promise.all([api('/api/tags'), api('/api/settings'), api('/api/memos')]);
    memos.sort(compareMemoDisplayOrder);
    renderTagSelector();
    renderFilterTags();
    loadSettings();
    await syncAIStatus().catch(() => {});
    setInterval(() => syncAIStatus().catch(() => {}),1500);
    window.addEventListener('focus',() => syncAIStatus().catch(() => {}));
    document.addEventListener('visibilitychange',() => { if(!document.hidden)syncAIStatus().catch(() => {}); });
    renderKanban();
    loadSuggestions();
    // Poll for cron-generated digest updates every 5 minutes
    setInterval(loadSuggestions, 5 * 60 * 1000);
  } catch (err) { console.error('Init error:', err); }
}

// === Live Clock ===
(function initClock() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  function tick() {
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const day = ['日','一','二','三','四','五','六'][now.getDay()];
    el.textContent = `${m}/${d} 周${day} ${h}:${min}:${s}`;
  }
  tick();
  setInterval(tick, 1000);
})();

// === Tag Selector (memo input) ===
const TAG_VISIBLE_LIMIT = 8;
let tagDisplayOrder = [];
let tagSelectorExpanded = false;
let tagDragSrc = null;

function getOrderedTags() {
  // Merge: ordered known tags first, then any new tags not yet in order
  const ordered = tagDisplayOrder.filter(t => allTags.includes(t));
  const extras = allTags.filter(t => !ordered.includes(t));
  return [...ordered, ...extras];
}

async function saveTagOrder() {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ tagOrder: tagDisplayOrder }) });
  } catch (err) { console.error(err); }
}

function renderTagSelector() {
  const container = document.getElementById('tagSelector');
  const ordered = getOrderedTags();
  const showAll = tagSelectorExpanded || ordered.length <= TAG_VISIBLE_LIMIT;
  const visible = showAll ? ordered : ordered.slice(0, TAG_VISIBLE_LIMIT);

  container.innerHTML = visible.map(tag => {
    const ci = tagColorIndex(tag);
    const sel = selectedTags.includes(tag) ? 'selected' : '';
    return `<span class="tag-chip tag-color-${ci} ${sel} ts-draggable" data-tag="${tag}" draggable="true">${tag}</span>`;
  }).join('');

  // "..." expand button
  if (!showAll) {
    const more = document.createElement('span');
    more.className = 'tag-chip ts-more-btn';
    more.textContent = `···  +${ordered.length - TAG_VISIBLE_LIMIT}`;
    more.title = '展开全部标签';
    more.addEventListener('click', () => { tagSelectorExpanded = true; renderTagSelector(); });
    container.appendChild(more);
  }

  // collapse button when expanded and there are more than limit
  if (tagSelectorExpanded && ordered.length > TAG_VISIBLE_LIMIT) {
    const collapse = document.createElement('span');
    collapse.className = 'tag-chip ts-collapse-btn';
    collapse.textContent = '收起';
    collapse.addEventListener('click', () => { tagSelectorExpanded = false; renderTagSelector(); });
    container.appendChild(collapse);
  }

  // click to select
  container.querySelectorAll('.tag-chip[data-tag]').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      selectedTags = selectedTags.includes(tag) ? selectedTags.filter(t => t !== tag) : [...selectedTags, tag];
      renderTagSelector();
    });
  });

  // drag-to-reorder (always enabled)
  {
    container.querySelectorAll('.tag-chip[data-tag]').forEach(chip => {
      chip.addEventListener('dragstart', e => {
        tagDragSrc = chip.dataset.tag;
        chip.classList.add('ts-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('ts-dragging');
        container.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('ts-dragover'));
      });
      chip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        container.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('ts-dragover'));
        chip.classList.add('ts-dragover');
      });
      chip.addEventListener('drop', e => {
        e.preventDefault();
        const dragTarget = chip.dataset.tag;
        if (!tagDragSrc || tagDragSrc === dragTarget) return;
        const ordered = getOrderedTags();
        const from = ordered.indexOf(tagDragSrc);
        const to = ordered.indexOf(dragTarget);
        ordered.splice(from, 1);
        ordered.splice(to, 0, tagDragSrc);
        tagDisplayOrder = ordered;
        saveTagOrder();
        renderTagSelector();
      });
    });
  }
}

// === Filter Tags ===
let filterSelectedTags = [];
let filterAllSelected = true;
let filterExpanded = false;
const FILTER_TAG_LIMIT = 5;

function renderFilterTags() {
  const container = document.getElementById('filterTags');
  const tagCounts = {};
  allTags.forEach(t => { tagCounts[t] = 0; });
  memos.forEach(m => m.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

  const firstRowTags = allTags.slice(0, FILTER_TAG_LIMIT);
  const extraTags = allTags.slice(FILTER_TAG_LIMIT);
  const hasMore = extraTags.length > 0;

  let html = `<span class="filter-label">筛选</span>`;
  html += `<span class="filter-tag ${filterAllSelected ? 'active' : ''}" data-tag="__all__">全部</span>`;
  html += firstRowTags.map(tag => {
    const active = !filterAllSelected && filterSelectedTags.includes(tag) ? 'active' : '';
    return `<span class="filter-tag ${active}" data-tag="${tag}">${tag} <span class="filter-count">${tagCounts[tag]||0}</span></span>`;
  }).join('');
  if (hasMore) {
    html += filterExpanded
      ? `<button class="filter-expand" data-action="collapse">▲</button>`
      : `<button class="filter-expand" data-action="expand">▼</button>`;
  }
  if (filterExpanded && hasMore) {
    // Force line break then show remaining tags
    html += `<div class="filter-tags-break"></div>`;
    html += extraTags.map(tag => {
      const active = !filterAllSelected && filterSelectedTags.includes(tag) ? 'active' : '';
      return `<span class="filter-tag ${active}" data-tag="${tag}">${tag} <span class="filter-count">${tagCounts[tag]||0}</span></span>`;
    }).join('');
  }
  container.innerHTML = html;

  container.querySelectorAll('.filter-tag').forEach(chip => {
    if (chip.dataset.tag !== '__all__') chip.title = chip.dataset.tag;
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      if (tag === '__all__') { filterAllSelected = true; filterSelectedTags = []; }
      else {
        filterAllSelected = false;
        filterSelectedTags = filterSelectedTags.includes(tag) ? filterSelectedTags.filter(t => t !== tag) : [...filterSelectedTags, tag];
        if (filterSelectedTags.length === 0) filterAllSelected = true;
      }
      applyFilters();
      renderFilterTags();
    });
  });
  const expandBtn = container.querySelector('.filter-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      filterExpanded = !filterExpanded;
      renderFilterTags();
    });
  }
  document.getElementById('clearFilterBtn').classList.toggle('hidden', filterAllSelected);
}

document.getElementById('clearFilterBtn').addEventListener('click', () => {
  filterAllSelected = true; filterSelectedTags = []; filteredMemos = null;
  renderFilterTags(); applyFilters();
});

function applyFilters() {
  if (document.getElementById('searchInput').value.trim()) { doSearch();return; }
  filteredMemos = filterAllSelected ? null : memos.filter(m => m.tags.some(t => filterSelectedTags.includes(t)));
  renderKanban();
}

// === Kanban ===
function renderKanban() {
  const grid = document.getElementById('kanbanGrid');
  const displayMemos = filteredMemos !== null ? filteredMemos : memos;
  if(!displayMemos.length) {
    const hint=document.createElement('p');hint.className='ga-empty-hint';
    hint.textContent=memos.length ? '这里还没有找到记录哦～换个关键词或标签试试吧～' : '还没有记录哦～随手写下第一句碎碎念吧～';
    grid.replaceChildren(hint);return;
  }

  // Flat 3-column grid — deduplicate memos (a memo may appear in multiple tag groups)
  const seen = new Set();
  const uniqueMemos = [];
  displayMemos.forEach(memo => {
    if (!seen.has(memo.id)) { seen.add(memo.id); uniqueMemos.push(memo); }
  });

  grid.innerHTML = uniqueMemos.map(memo => {
    const primaryTag = memo.tags[0] || '未分类';
    const emoji = getTagEmoji(primaryTag);
    const tapeClass = getTagTape(primaryTag);
    const paperClass = PAPERS[hash(memo.id+'p') % PAPERS.length];
    const rotation = (hash(memo.id+'r') % 5) - 2;
    const hasSpiral = paperClass === 'paper-grid';
    const spiralHTML = hasSpiral ? '<div class="memo-spiral"><span></span><span></span><span></span><span></span><span></span></div>' : '';
    const spiralPadding = hasSpiral ? 'style="padding-left:10px"' : '';
    const tagsHtml = memo.tags.map(t => `<span class="memo-tag">${t}</span>`).join(' ');
    const pinBadge = memo.pinned ? '<div class="memo-pin-badge"><svg viewBox="0 0 24 24" fill="var(--t-accent)"><path d="M17 4v7l2 3v2h-6v5l-1 3-1-3v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg></div>' : '';
    const pinBtnClass = 'pin-btn';
    return `
      <div class="memo-card ${paperClass}" data-id="${memo.id}">
        <div class="memo-card-tape">
          <span class="tape ${tapeClass}" style="transform:rotate(${rotation}deg)">${emoji} ${primaryTag}</span>
        </div>
        <div class="memo-card-body">
          ${pinBadge}
          ${spiralHTML}
          <div class="memo-card-content" ${spiralPadding} onclick="showMemoDetail('${memo.id}')">${escapeHtml(memo.content)}</div>
          <div class="memo-card-meta" ${spiralPadding}>
            <div class="memo-card-tags">${tagsHtml}</div>
            <div class="memo-card-meta-right">
              <span>${formatTime(memo.createdAt)}</span>
              <div class="memo-card-actions">
                <button onclick="togglePin('${memo.id}')" title="${memo.pinned ? '取消置顶' : '置顶'}" class="${pinBtnClass}"><svg width="13" height="13" viewBox="0 0 24 24"><path d="M17 4v7l2 3v2h-6v5l-1 3-1-3v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg></button>
                <button onclick="editMemo('${memo.id}')" title="编辑">✏️</button>
                <button onclick="confirmDeleteMemo('${memo.id}')" title="删除">🗑️</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

}

// === Memo Detail Modal ===
function showMemoDetail(id) {
  const memo = memos.find(m => m.id === id);
  if (!memo) return;
  document.getElementById('memoDetailTitle').textContent = `${getTagEmoji(memo.tags[0] || '')} 手帐详情`;
  document.getElementById('memoDetailTags').innerHTML = memo.tags.map(t => `<span class="memo-tag">${getTagEmoji(t)} ${t}</span>`).join(' ');
  document.getElementById('memoDetailContent').textContent = memo.content;
  document.getElementById('memoDetailTime').textContent = formatTime(memo.createdAt);
  document.getElementById('memoDetailModal').classList.remove('hidden');
  document.getElementById('memoDetailContent').scrollTop = 0;
}

document.getElementById('memoDetailClose').addEventListener('click', () => { document.getElementById('memoDetailModal').classList.add('hidden'); });

// === Send Memo ===
document.getElementById('sendBtn').addEventListener('click', sendMemo);
// Enter = newline (default textarea behavior), no send on Enter

async function sendMemo() {
  const input = document.getElementById('memoInput');
  const content = input.value.trim();
  if (!content) { showToast('还没写内容哦～随手记下一句再保存吧～');return; }
  try {
    const memo = await api('/api/memos', { method: 'POST', body: JSON.stringify({ content, tags: selectedTags }) });
    memos.unshift(memo);
    memos.sort(compareMemoDisplayOrder);
    input.value = '';
    renderFilterTags(); applyFilters();
  } catch (err) { console.error(err);showToast(err.message); }
}

// === Tag Manager ===
let selectedNewEmoji = '🏷️';

let selectedNewTape = 'tape-1';

document.getElementById('tagManagerBtn').addEventListener('click', () => {
  selectedNewEmoji = '🏷️';
  selectedNewTape = 'tape-1';
  document.getElementById('emojiPickerSelected').textContent = selectedNewEmoji;
  document.getElementById('newTagName').value = '';
  document.getElementById('emojiPicker').classList.add('hidden');
  renderNewTapePicker();
  renderEmojiPicker();
  renderTagManagerList();
  document.getElementById('tagManagerModal').classList.remove('hidden');
});

function renderNewTapePicker() {
  let container = document.getElementById('newTapePicker');
  if (!container) {
    container = document.createElement('div');
    container.id = 'newTapePicker';
    container.className = 'tape-picker';
    const addBtn = document.getElementById('addNewTagBtn');
    addBtn.parentElement.insertBefore(container, addBtn);
  }
  container.innerHTML = TAPES.map((t, i) => `<span class="tape-picker-item tape ${t} ${t === selectedNewTape ? 'tape-picked' : ''}" data-tape="${t}" title="${TAPE_LABELS[i]}">&nbsp;</span>`).join('');
  container.querySelectorAll('.tape-picker-item').forEach(el => {
    el.addEventListener('click', () => { selectedNewTape = el.dataset.tape; renderNewTapePicker(); });
  });
}

document.getElementById('emojiPickerSelected').addEventListener('click', () => {
  document.getElementById('emojiPicker').classList.toggle('hidden');
});

function renderEmojiPicker() {
  const container = document.getElementById('emojiPicker');
  container.innerHTML = Object.entries(EMOJI_GROUPS).map(([group, emojis]) => `
    <div class="emoji-picker-group">
      <div class="emoji-picker-group-label">${group}</div>
      <div class="emoji-picker-grid">
        ${emojis.map(e => `<span class="emoji-option ${e === selectedNewEmoji ? 'selected' : ''}" data-emoji="${e}">${e}</span>`).join('')}
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.emoji-option').forEach(el => {
    el.addEventListener('click', () => {
      selectedNewEmoji = el.dataset.emoji;
      document.getElementById('emojiPickerSelected').textContent = selectedNewEmoji;
      document.getElementById('emojiPicker').classList.add('hidden');
      renderEmojiPicker();
    });
  });
}

function renderTagManagerList() {
  const container = document.getElementById('tagManagerList');
  const tagCounts = {};
  allTags.forEach(t => { tagCounts[t] = 0; });
  memos.forEach(m => m.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

  container.innerHTML = allTags.map(tag => {
    const tape = getTagTape(tag);
    const emoji = getTagEmoji(tag);
    return `
    <div class="tag-manager-item" data-tag="${tag}">
      <span class="tape ${tape} tag-manager-tape" title="点击换花纹">${emoji}</span>
      <span class="tag-name">${tag}</span>
      <span class="tag-count">${tagCounts[tag] || 0} 条</span>
      <button class="tag-edit" data-tag="${tag}" title="编辑">✏️</button>
      <button class="tag-delete" data-tag="${tag}" title="删除">✕</button>
    </div>`;
  }).join('') || '<p style="color:var(--t-text-light);text-align:center;padding:12px">还没有标签哦～可以先添一个喜欢的名字～</p>';

  // Edit button — show inline tape + emoji picker
  container.querySelectorAll('.tag-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const item = btn.closest('.tag-manager-item');
      // Toggle edit panel
      let panel = item.querySelector('.tag-edit-panel');
      if (panel) {
        // revert preview on toggle-close
        const tapeSpan = item.querySelector('.tag-manager-tape');
        if (tapeSpan) { tapeSpan.className = `tape ${getTagTape(tag)} tag-manager-tape`; tapeSpan.textContent = getTagEmoji(tag); }
        panel.remove(); return;
      }
      panel = document.createElement('div');
      panel.className = 'tag-edit-panel';
      const originalTape = getTagTape(tag);
      const originalEmoji = getTagEmoji(tag);
      let pendingTape = originalTape;
      let pendingEmoji = originalEmoji;
      const tapePreview = item.querySelector('.tag-manager-tape');

      function updatePreview() {
        if (tapePreview) {
          tapePreview.className = `tape ${pendingTape} tag-manager-tape`;
          tapePreview.textContent = pendingEmoji;
        }
      }

      function revertPreview() {
        if (tapePreview) {
          tapePreview.className = `tape ${originalTape} tag-manager-tape`;
          tapePreview.textContent = originalEmoji;
        }
      }

      let pendingName = tag;
      function renderEditPanel() {
        panel.innerHTML = `
          <div class="tag-edit-section"><span style="font-size:12px;color:var(--t-text-light)">标签名</span>
            <input class="tag-edit-name-input" value="${escapeHtml(pendingName)}" maxlength="20" placeholder="标签名称">
          </div>
          <div class="tag-edit-section"><span style="font-size:12px;color:var(--t-text-light)">花纹</span>
            <div class="tape-picker">${TAPES.map((t, i) => `<span class="tape-picker-item tape ${t} ${t === pendingTape ? 'tape-picked' : ''}" data-tape="${t}" title="${TAPE_LABELS[i]}">&nbsp;</span>`).join('')}</div>
          </div>
          <div class="tag-edit-section"><span style="font-size:12px;color:var(--t-text-light)">表情</span>
            <div class="tag-edit-emoji-scroll">${Object.entries(EMOJI_GROUPS).map(([group, emojis]) => `
              <div class="tag-edit-emoji-group">
                <span class="tag-edit-emoji-label">${group}</span>
                <div class="tag-edit-emoji-row">${emojis.map(e => `<span class="emoji-mini-option ${e === pendingEmoji ? 'tape-picked' : ''}" data-emoji="${e}">${e}</span>`).join('')}</div>
              </div>`).join('')}
            </div>
          </div>
          <div class="tag-edit-actions">
            <button class="tag-edit-confirm btn-primary btn-small">确认修改</button>
            <button class="tag-edit-cancel btn-small">取消</button>
          </div>`;
        panel.querySelector('.tag-edit-name-input').addEventListener('input', e => { pendingName = e.target.value; });
        panel.querySelectorAll('.tape-picker-item').forEach(el => {
          el.addEventListener('click', () => { pendingTape = el.dataset.tape; updatePreview(); renderEditPanel(); });
        });
        panel.querySelectorAll('.emoji-mini-option').forEach(el => {
          el.addEventListener('click', () => { pendingEmoji = el.dataset.emoji; updatePreview(); renderEditPanel(); });
        });
        panel.querySelector('.tag-edit-confirm').addEventListener('click', async () => {
          const newName = pendingName.trim();
          if (!newName) return;
          try {
            if (newName !== tag) {
              const res = await api(`/api/tags/${encodeURIComponent(tag)}`, { method: 'PUT', body: JSON.stringify({ newTag: newName }) });
              if (res.error === 'exists') { showModalToast('标签已经存在了喔～'); return; }
              allTags = res.tags;
              memos = (await api('/api/memos')).sort(compareMemoDisplayOrder);
            }
            const effectiveName = newName;
            const tagTapes = settings.tagTapes || {};
            tagTapes[effectiveName] = pendingTape;
            const tagEmojis = settings.tagEmojis || {};
            tagEmojis[effectiveName] = pendingEmoji;
            settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ tagTapes, tagEmojis }) });
            renderTagManagerList(); renderKanban(); renderFilterTags(); renderTagSelector();
            showModalToast('修改成功！✓');
          } catch(err) { console.error(err); }
        });
        panel.querySelector('.tag-edit-cancel').addEventListener('click', () => { revertPreview(); panel.remove(); });
      }
      item.appendChild(panel);
      renderEditPanel();
    });
  });

  // Delete button
  container.querySelectorAll('.tag-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      showConfirm(`确定删除标签「${tag}」吗？\n所有该标签下的任务都会被一并删除哦`, async () => {
        try {
          const res = await api(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
          allTags = res.tags;
          memos = (await api('/api/memos')).sort(compareMemoDisplayOrder);
          settings = await api('/api/settings');
          renderTagManagerList(); renderTagSelector(); renderFilterTags(); renderKanban();
        } catch (err) { console.error(err); }
      });
    });
  });
}

document.getElementById('addNewTagBtn').addEventListener('click', async () => {
  const name = document.getElementById('newTagName').value.trim();
  if (!name) return;
  if (allTags.includes(name)) { showModalToast('标签已经存在了喔～'); return; }
  try {
    allTags = await api('/api/tags', { method: 'POST', body: JSON.stringify({ tag: name, emoji: selectedNewEmoji }) });
    // Save tape + emoji for this tag
    const tagTapes = settings.tagTapes || {};
    tagTapes[name] = selectedNewTape;
    const tagEmojis = settings.tagEmojis || {};
    tagEmojis[name] = selectedNewEmoji;
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ tagTapes, tagEmojis }) });
    document.getElementById('newTagName').value = '';
    selectedNewEmoji = '🏷️';
    selectedNewTape = 'tape-1';
    document.getElementById('emojiPickerSelected').textContent = selectedNewEmoji;
    renderNewTapePicker();
    renderTagManagerList();
    renderTagSelector();
    renderFilterTags();
    showModalToast('添加成功！🎉');
  } catch (err) { console.error(err); }
});
document.getElementById('tagManagerClose').addEventListener('click', () => { document.getElementById('tagManagerModal').classList.add('hidden'); });

// === Edit / Delete Memo ===
async function editMemo(id) {
  const card = document.querySelector(`.memo-card[data-id="${id}"]`);
  if (!card || card.classList.contains('editing')) return;
  const memo = memos.find(m => m.id === id);
  if (!memo) return;
  card.classList.add('editing');
  const contentEl = card.querySelector('.memo-card-content');
  contentEl.style.display = 'none';
  let editTags = [...memo.tags];
  const editTagList = getOrderedTags();
  const tagCheckboxes = editTagList.map(t => {
    const checked = editTags.includes(t) ? 'checked' : '';
    return `<label class="memo-edit-tag-label"><input type="checkbox" value="${escapeHtml(t)}" ${checked}> ${getTagEmoji(t)} ${escapeHtml(t)}</label>`;
  }).join('');
  const editDiv = document.createElement('div');
  editDiv.innerHTML = `<textarea class="memo-edit-input"></textarea><div class="memo-edit-tag-picker">${tagCheckboxes}</div><div class="memo-edit-actions"><button class="memo-edit-save">保存</button><button class="memo-edit-cancel">取消</button></div>`;
  // Memo content is plain text, including HTML-looking text and textarea end tags.
  editDiv.querySelector('textarea').value = memo.content;
  card.querySelector('.memo-card-body').insertBefore(editDiv, card.querySelector('.memo-card-meta'));
  editDiv.querySelectorAll('.memo-edit-tag-label input').forEach(cb => {
    cb.addEventListener('change', () => {
      editTags = Array.from(editDiv.querySelectorAll('.memo-edit-tag-label input:checked')).map(el => el.value);
    });
  });
  editDiv.querySelector('.memo-edit-cancel').addEventListener('click', () => { card.classList.remove('editing'); contentEl.style.display = ''; editDiv.remove(); });
  editDiv.querySelector('.memo-edit-save').addEventListener('click', async () => {
    const newContent = editDiv.querySelector('textarea').value.trim();
    if (!newContent) { showToast('还没写内容哦～随手记下一句再保存吧～');return; }
    try {
      const updated = await api(`/api/memos/${id}`, { method: 'PUT', body: JSON.stringify({ content: newContent, tags: editTags }) });
      const idx = memos.findIndex(m => m.id === id);
      if (idx !== -1) memos[idx] = updated;
      renderKanban();
    } catch (err) { console.error(err); }
  });
}

function confirmDeleteMemo(id) {
  showConfirm('确定删除这条手帐？', async () => {
    try {
      await api(`/api/memos/${id}`, { method: 'DELETE' });
      memos = memos.filter(m => m.id !== id);
      renderFilterTags(); renderKanban();
    } catch (err) { console.error(err); }
  });
}

async function togglePin(id) {
  const memo = memos.find(m => m.id === id);
  if (!memo) return;
  const pinned = !memo.pinned;
  try {
    await api(`/api/memos/${id}`, { method: 'PUT', body: JSON.stringify({ pinned }) });
    memo.pinned = pinned;
    memos.sort(compareMemoDisplayOrder);
    applyFilters();
    showToast(pinned ? '已置顶' : '已取消置顶');
  } catch (err) { console.error(err); }
}

// === Local Search ===
let searchSequence = 0;
let searchTimer;
const updateSearchHint = () => {
  document.getElementById('searchHint').textContent = '';
};
document.getElementById('searchInput').addEventListener('input', () => {
  const keyword = document.getElementById('searchInput').value.trim();
  document.getElementById('searchClearBtn').classList.toggle('hidden',!keyword);
  clearTimeout(searchTimer);
  ++searchSequence;
  if (!keyword) return clearSearch();
  searchTimer = setTimeout(doSearch,150);
});
document.getElementById('searchMode').addEventListener('change', () => { updateSearchHint(); doSearch(); });
document.getElementById('searchInput').addEventListener('keydown', event => { if(event.key === 'Enter') { clearTimeout(searchTimer);doSearch(); } });
document.getElementById('searchClearBtn').addEventListener('click',clearSearch);

function clearSearch() {
  ++searchSequence;clearTimeout(searchTimer);
  window._ccActivity.cancel('local-search');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClearBtn').classList.add('hidden');
  document.getElementById('clearSearchBtn').classList.add('hidden');
  updateSearchHint();applyFilters();
}

async function doSearch() {
  const keyword = document.getElementById('searchInput').value.trim();
  if (!keyword) return clearSearch();
  const sequence = ++searchSequence;
  const activity = window._ccActivity.begin('local-search','looking',5);
  let success = true;
  const params = new URLSearchParams({keyword,mode:document.getElementById('searchMode').value});
  if(filterSelectedTags.length)params.set('tags',JSON.stringify(filterSelectedTags));
  try {
    const results = await api(`/api/memos?${params}`);
    if(sequence !== searchSequence)return;
    filteredMemos = results;
    document.getElementById('clearSearchBtn').classList.remove('hidden');
    renderKanban();
    document.getElementById('searchHint').textContent = `找到 ${results.length} 条便签`;
  } catch(error) {
    success = false;
    if(sequence === searchSequence)showToast(error.message);
  } finally {
    if (sequence === searchSequence) window._ccActivity.end('local-search',activity,{success,feedback:!success});
    else window._ccActivity.cancel('local-search',activity);
  }
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

// === Daily Digest ===
let currentDailyDigest = null;
document.getElementById('digestToggle').addEventListener('click', () => { document.getElementById('digestBanner').classList.toggle('digest-collapsed'); });

document.getElementById('digestRegenBtn').addEventListener('click', async () => {
  if (await checkCCAvailable()) return;
  if (await checkCCBusy()) return;
  const btn = document.getElementById('digestRegenBtn');
  btn.disabled = true; btn.textContent = '生成中...';
  showCCTask('生成今日摘要',{type:'daily-digest'});
  try {
    const res = await api('/api/cc/ask', { method: 'POST', body: JSON.stringify({ action: 'daily-digest' }) });
    window.setAITaskNavigationResult?.('生成今日摘要',{type:'daily-digest',generatedAt:res.digest?.generatedAt});
    hideCCTask('生成今日摘要'); btn.disabled = false; btn.textContent = '重新生成';
    showDigest(res.digest);
  } catch (err) { hideCCTask('生成今日摘要',false); btn.disabled = false; btn.textContent = '重新生成'; console.error(err); if(!err.ccBusy)showToast(err.message); }
});

function toggleSummary(btn) {
  const content = btn.closest('.tag-summary-item').querySelector('.tag-summary-item-content');
  content.classList.toggle('collapsed-content');
  btn.textContent = content.classList.contains('collapsed-content') ? '▸' : '▾';
}

function showDigest(digest, legacyScope = false) {
  if (!digest) return;
  currentDailyDigest = digest;
  const banner = document.getElementById('digestBanner');
  document.getElementById('digestTitle').textContent = `${digest.date || '今日'} 摘要${legacyScope ? ' · 之前的摘要' : ''}`;
  if(legacyScope)console.info('[Digest] Legacy digest has no local date range',{date:digest.date});
  const summary = window.memoMessages.digestText(digest,{legacy:legacyScope});
  document.getElementById('digestText').innerHTML = escapeHtml(summary).replace(/\n/g, '<br>');
  document.getElementById('digestTasks').innerHTML = '';
  banner.classList.remove('hidden', 'digest-collapsed');
}

document.getElementById('suggestClose').addEventListener('click', () => { document.getElementById('suggestBanner').classList.add('hidden'); });

// === Tag Suggestions (history modal) ===
let tagSuggestHistory = [];

document.getElementById('btnTagSuggest').addEventListener('click', async () => {
  try {
    const data = await api('/api/cc/suggestions');
    tagSuggestHistory = data.tagSuggestionHistory || [];
  } catch { tagSuggestHistory = []; }
  renderTagSuggestHistory();
  document.getElementById('tagSuggestModal').classList.remove('hidden');
});

document.getElementById('tagSuggestGenBtn').addEventListener('click', async () => {
  if (await checkCCAvailable()) return;
  if (await checkCCBusy()) return;
  const btn = document.getElementById('tagSuggestGenBtn');
  btn.disabled = true; btn.textContent = '生成中...';
  showCCTask('生成标签建议',{type:'tag-suggestions'});
  try {
    const result = await api('/api/cc/ask', { method: 'POST', body: JSON.stringify({ action: 'tag-suggestions' }) });
    window.setAITaskNavigationResult?.('生成标签建议',{type:'tag-suggestions',generatedAt:result.generatedAt});
    hideCCTask('生成标签建议'); btn.disabled = false; btn.textContent = '生成建议';
    const data = await api('/api/cc/suggestions');
    tagSuggestHistory = data.tagSuggestionHistory || [];
    renderTagSuggestHistory();
  } catch (err) { hideCCTask('生成标签建议',false); btn.disabled = false; btn.textContent = '生成建议'; console.error(err); if(!err.ccBusy)showToast(err.message); }
});

function renderTagSuggestHistory() {
  const container = document.getElementById('tagSuggestHistory');
  if (tagSuggestHistory.length === 0) {
    container.innerHTML = '<p style="color:var(--text-light);font-size:13px;text-align:center;padding:20px 0">还没有整理过标签哦～点一下「生成建议」试试吧～</p>';
    return;
  }
  container.innerHTML = tagSuggestHistory.map((item, idx) => {
    const content = (item.suggestions || []).map(s => {
      if (s.action === 'merge') return `合并建议: ${s.tags.join(' + ')} — ${s.reason}`;
      return `检查: ${s.tag || s.tags?.join(', ')} — ${s.reason}`;
    }).join('\n') || (item.coverage?.processedCount===0 ? '这里还没有记录哦～先随手记几句，再来整理标签吧～' : '这次没有需要调整的标签哦～先这样记着就好～');
    return `
      <div class="tag-summary-item">
        <div class="tag-summary-item-header">
          <span>${formatTime(item.generatedAt)}${item.coverage ? ` · 已分析 ${item.coverage.processedCount} 条` : ''}</span>
          <span class="tag-summary-item-tag" style="background:var(--accent-light);color:var(--accent)">标签建议</span>
          <div class="summary-item-actions">
            <button onclick="toggleSummary(this)">▸</button>
            <button class="delete-btn" onclick="deleteTagSuggest(${idx})">✕</button>
          </div>
        </div>
        <div class="tag-summary-item-content collapsed-content">${escapeHtml(content)}</div>
      </div>`;
  }).join('');
  container.querySelectorAll('.tag-summary-item').forEach((row,index)=>{row.dataset.generatedAt=tagSuggestHistory[index].generatedAt || '';});
}

async function deleteTagSuggest(idx) {
  showConfirm('确定删除这条建议？', async () => {
    try {
      await api(`/api/cc/tag-suggestion/${idx}`, { method: 'DELETE' });
      tagSuggestHistory.splice(idx, 1);
      renderTagSuggestHistory();
    } catch (err) { console.error(err); }
  });
}

document.getElementById('tagSuggestClose').addEventListener('click', () => { document.getElementById('tagSuggestModal').classList.add('hidden'); });

// === Graph + Summary (split view) ===
let graphHistory = [];
let graphIndex = 0;
let graphSelectedTags = [];
let graphCollapsed = false;
let graphEntryId = null;
let graphSimulation = null;
let graphResizeObserver = null;

// Markdown helper — uses marked.js if loaded, falls back to escaped text
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    const template=document.createElement('template');
    template.innerHTML=marked.parse(String(text), { breaks: true, gfm: true });
    const allowed=new Set(['P','BR','STRONG','EM','DEL','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','PRE','CODE','HR','A','TABLE','THEAD','TBODY','TR','TH','TD']);
    for(const element of template.content.querySelectorAll('*')) {
      if(element.namespaceURI!=='http://www.w3.org/1999/xhtml' || !allowed.has(element.tagName)) {
        if(['SCRIPT','STYLE'].includes(element.tagName))element.remove();
        else element.replaceWith(document.createTextNode(element.textContent));
        continue;
      }
      const href=element.getAttribute('href');
      for(const attribute of [...element.attributes])element.removeAttribute(attribute.name);
      if(element.tagName==='A' && href) {
        try {
          const url=new URL(href,location.href);
          if(['http:','https:','mailto:'].includes(url.protocol))element.setAttribute('href',url.href);
        } catch {}
      }
    }
    return template.innerHTML;
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Safe CSS id from a tag name
function tagToCardId(tag) {
  return 'ga-sum-' + String(tag).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-');
}

// Open graph modal
document.getElementById('btnTagGraph').addEventListener('click', async () => {
  graphSelectedTags = [];
  document.getElementById('graphModal').classList.remove('hidden');
  renderGraphTagPicker();
  try {
    const data = await api('/api/cc/suggestions');
    graphHistory = data.graphHistory || [];
    // Migrate old taskGraph if present
    if (graphHistory.length === 0 && data.taskGraph && data.taskGraph.nodes && data.taskGraph.nodes.length > 0) {
      graphHistory = [{ ...data.taskGraph, id: 'migrated', summaries: [], insights: '', tags: [], generatedAt: data.taskGraph.generatedAt || '' }];
    }
    if (graphHistory.length > 0) {
      graphIndex = graphHistory.length - 1;
      renderCurrentGraph();
    } else {
      document.getElementById('graphContainer').innerHTML =
        '<p style="text-align:center;padding:40px;color:var(--t-text-light)">选择标签范围后点击"生成图谱"</p>';
      document.getElementById('graphDate').textContent = '';
      document.getElementById('graphCollapseAll').disabled=true;
      document.getElementById('graphCoverage').textContent='';
      document.getElementById('graphNav').style.display = 'none';
      document.getElementById('graphInsights').style.display = 'none';
      document.getElementById('graphSummaryPanel').innerHTML =
        '<p class="ga-empty-hint">选择标签后点击"生成图谱"开始</p>';
    }
  } catch {}
});

let graphTagExpanded = false;
const GRAPH_TAG_LIMIT = 8;

function renderGraphTagPicker() {
  const container = document.getElementById('graphTagPicker');
  const showAll = graphTagExpanded || allTags.length <= GRAPH_TAG_LIMIT;
  const visible = showAll ? allTags : allTags.slice(0, GRAPH_TAG_LIMIT);
  const hasMore = allTags.length > GRAPH_TAG_LIMIT;

  let html = visible.map(tag => {
    const ci = tagColorIndex(tag);
    const sel = graphSelectedTags.includes(tag) ? 'active' : '';
    return `<span class="filter-tag tag-color-${ci} ${sel}" data-tag="${tag}">${tag}</span>`;
  }).join('');
  if (hasMore) {
    html += graphTagExpanded
      ? `<button class="filter-expand" data-action="collapse">▲</button>`
      : `<button class="filter-expand" data-action="expand">··· +${allTags.length - GRAPH_TAG_LIMIT}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.filter-tag').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      graphSelectedTags = graphSelectedTags.includes(tag)
        ? graphSelectedTags.filter(t => t !== tag)
        : [...graphSelectedTags, tag];
      renderGraphTagPicker();
    });
  });
  const expandBtn = container.querySelector('.filter-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => { graphTagExpanded = !graphTagExpanded; renderGraphTagPicker(); });
  }
}

// Render current graph from history
function renderCurrentGraph() {
  if (graphHistory.length === 0) return;
  const entry = graphHistory[graphIndex];
  if(graphEntryId !== entry.id){graphEntryId=entry.id;graphCollapsed=false;}
  document.getElementById('graphCollapseAll').textContent=graphCollapsed ? '全部展开' : '一键折叠';
  document.getElementById('graphCollapseAll').disabled=!entry.nodes?.length;
  document.getElementById('graphCoverage').textContent=entry.coverage
    ? `已分析 ${entry.coverage.processedCount}/${entry.coverage.matchedCount} 条便签 · ${entry.coverage.batchCount} 批${entry.coverage.from || entry.coverage.to ? ` · ${entry.coverage.from || '不限开始'} 至 ${entry.coverage.to || '不限结束'}` : ''}`
    : '这是之前留下的图谱哦～点「生成图谱」可以重新整理最近的记录～';
  // Nav
  const nav = document.getElementById('graphNav');
  nav.style.display = graphHistory.length > 0 ? 'flex' : 'none';
  document.getElementById('graphNavInfo').textContent = `${graphIndex + 1} / ${graphHistory.length}`;
  document.getElementById('graphPrev').disabled = graphIndex <= 0;
  document.getElementById('graphNext').disabled = graphIndex >= graphHistory.length - 1;
  // Meta: date + tags
  const metaEl = document.getElementById('graphNavMeta');
  const dateStr = entry.generatedAt ? formatTime(entry.generatedAt) : '';
  const tagsHtml = (entry.tags || []).map(t => {
    const ci = tagColorIndex(t);
    return `<span class="ga-meta-tag tag-color-${ci}">${t}</span>`;
  }).join('');
  metaEl.innerHTML = `<span>${dateStr}</span>${tagsHtml}`;
  // Graph
  renderGraph(entry);
  // Insights
  const insightsEl = document.getElementById('graphInsights');
  if (entry.insights && (!Array.isArray(entry.insights) || entry.insights.length)) {
    insightsEl.style.display = '';
    document.getElementById('graphInsightsContent').innerHTML = renderMarkdown(Array.isArray(entry.insights) ? entry.insights.join('\n') : entry.insights);
  } else {
    insightsEl.style.display = 'none';
  }
  // Summaries
  renderGraphSummaryPanel(entry);
  // Date in footer
  document.getElementById('graphDate').textContent = entry.generatedAt ? `生成于 ${dateStr}` : '';
}

function renderGraphSummaryPanel(entry, selected = null) {
  const panel=document.getElementById('graphSummaryPanel');panel.replaceChildren();
  const view=window.memoGraphLayout.makeView(entry,graphCollapsed);
  if(selected) {
    const card=document.createElement('div');card.className='ga-sum-card';
    const title=document.createElement('div');title.className='ga-sum-card-header';title.textContent=selected.label;card.append(title);
    if(!selected.memoIds.length){const note=document.createElement('p');note.className='ga-source-note';note.textContent='这个想法还没有连到原便签哦～可以重新生成图谱试试～';card.append(note);}
    for(const id of selected.memoIds) {
      const memo=memos.find(item=>item.id===id);
      if(!memo){const missing=document.createElement('p');missing.className='ga-source-note';missing.textContent='原来的便签找不到了哦～可能已经被删掉了～';card.append(missing);continue;}
      const button=document.createElement('button');button.className='ga-source-button';button.textContent=`${formatTime(memo.createdAt)} · 查看原便签`;button.addEventListener('click',()=>showMemoDetail(id));
      const content=document.createElement('p');content.className='ga-source-text';content.textContent=memo.content;
      card.append(button,content);
      if(new Date(memo.updatedAt)>new Date(entry.generatedAt)){const changed=document.createElement('p');changed.className='ga-source-note';changed.textContent='这条便签后来改过哦～这里显示的是最新内容～';card.append(changed);}
    }
    panel.append(card);
  }
  const sections=entry.summaries?.length ? entry.summaries.map(item=>({title:item.tag,summary:item.summary,memoIds:(entry.clusters || []).find(cluster=>cluster.title===item.tag)?.memoIds || []})) : entry.clusters || [];
  for(const cluster of sections) {
    const card=document.createElement('div');card.className='ga-sum-card';
    const button=document.createElement('button');button.className='ga-cluster-button';button.textContent=cluster.title+(cluster.memoIds.length ? ` · ${cluster.memoIds.length} 条` : '');
    button.addEventListener('click',()=>renderGraphSummaryPanel(entry,{label:cluster.title,memoIds:cluster.memoIds}));
    const summary=document.createElement('div');summary.className='ga-source-text';summary.innerHTML=renderMarkdown(cluster.summary);
    card.append(button,summary);panel.append(card);
  }
  if(!panel.children.length)panel.textContent='还没有整理出小结哦～可以再试一次～';
}

function renderGraph(data) {
  if(graphSimulation)graphSimulation.stop();
  if(graphResizeObserver)graphResizeObserver.disconnect();
  const container=document.getElementById('graphContainer');container.replaceChildren();
  if(!container.clientWidth || !container.clientHeight)return;
  if(!data.nodes?.length){container.textContent='还没有图谱哦～选好记录，再点「生成图谱」试试吧～';return;}
  if(typeof d3==='undefined'){console.error('[Graph] D3 is not loaded');container.textContent='图谱还没准备好哦～检查一下网络，再刷新试试吧～';return;}
  const view=window.memoGraphLayout.makeView(data,graphCollapsed);
  const width=container.clientWidth || 700,height=container.clientHeight || 460;
  const columns=Math.max(1,Math.round(Math.sqrt(view.clusters.length*width/height)));
  const rows=Math.ceil(view.clusters.length/columns);
  const anchors=new Map(view.clusters.map((cluster,index)=>{
    return [cluster.id,{x:width*(index%columns+.5)/columns,y:height*(Math.floor(index/columns)+.5)/rows}];
  }));
  view.nodes.forEach(node=>{const anchor=anchors.get(node.clusterId) || {x:width/2,y:height/2};node.x=anchor.x+(hash(node.id)%31)-15;node.y=anchor.y+(hash(node.id+'y')%31)-15;});
  try {
    const svg=d3.select(container).append('svg').attr('width',width).attr('height',height).attr('role','img').attr('aria-label',`${view.nodes.length} 个${graphCollapsed ? '主题簇' : '思绪节点'}的思绪网络图`);
    const scene=svg.append('g');svg.call(d3.zoom().scaleExtent([.35,3]).on('zoom',event=>scene.attr('transform',event.transform)));
    const themeLine=scene.append('g').selectAll('line').data(view.themeEdges).join('line').attr('class','graph-theme-link');
    themeLine.append('title').text(edge=>`主题关联：${edge.relation}`);
    const link=scene.append('g').selectAll('line').data(view.edges).join('line').attr('class','graph-link');
    link.append('title').text(edge=>`${edge.kind==='theme' ? '主题关联' : '便签关联'}：${edge.relation || ''}`);
    const linkLabel=scene.append('g').selectAll('text').data(view.edges).join('text').attr('class','graph-link-label').text(edge=>{
      const characters=Array.from(edge.relation || '');
      return characters.length>12 ? characters.slice(0,12).join('')+'…' : characters.join('');
    });
    const headingNodes=(graphCollapsed ? [] : view.clusters).map(cluster=>({...cluster,...anchors.get(cluster.id)}));
    const showCluster=(event,cluster)=>renderGraphSummaryPanel(data,{label:cluster.title,memoIds:cluster.memoIds.length ? cluster.memoIds : [...new Set(view.nodes.filter(item=>item.clusterId===cluster.id).flatMap(item=>item.memoIds))]});
    const labels=scene.append('g').selectAll('g').data(headingNodes).join('g').attr('class','graph-cluster-heading')
      .attr('role','button').attr('tabindex',0).attr('aria-label',cluster=>cluster.title)
      .on('click',showCluster).on('keydown',(event,cluster)=>{if(['Enter',' '].includes(event.key)){event.preventDefault();showCluster(event,cluster);}});
    labels.append('title').text(cluster=>cluster.title);
    const headingText=labels.append('text').attr('class','graph-cluster-label').attr('text-anchor','middle');
    const fitText=(selection,text,maxChars,maxWidth)=>selection.each(function(item){
      const element=this;
      element.textContent=window.memoGraphLayout.fitLabel(text(item),maxChars,maxWidth,value=>{element.textContent=value;return element.getComputedTextLength();});
    });
    fitText(headingText,cluster=>cluster.title,12,Math.min(156,width-32));
    graphSimulation=d3.forceSimulation(view.nodes).alphaDecay(.04)
      .force('link',d3.forceLink(view.edges).id(node=>node.id).distance(graphCollapsed ? 130 : 85))
      .force('charge',d3.forceManyBody().strength(graphCollapsed ? -300 : -110))
      .force('x',d3.forceX(node=>(anchors.get(node.clusterId) || {x:width/2}).x).strength(.16))
      .force('y',d3.forceY(node=>(anchors.get(node.clusterId) || {y:height/2}).y).strength(.16));
    let selectedNodeId=null;
    const highlightRelations=id=>{
      const connected=edge=>id!==null && [edge.source.id,edge.target.id].includes(id);
      link.classed('is-highlighted',connected);
      linkLabel.classed('is-visible',connected);
    };
    const selectNode=(event,node)=>{selectedNodeId=node.id;highlightRelations(node.id);scene.selectAll('.graph-node').classed('selected',item=>item.id===node.id).attr('aria-pressed',item=>String(item.id===node.id));renderGraphSummaryPanel(data,node);};
    const node=scene.append('g').selectAll('g').data(view.nodes).join('g').attr('class','graph-node').attr('role','button').attr('tabindex',0).attr('aria-pressed','false').attr('aria-label',item=>`${item.label}，查看来源便签`)
      .on('click',selectNode).on('keydown',(event,item)=>{if(['Enter',' '].includes(event.key)){event.preventDefault();selectNode(event,item);}})
      .on('mouseenter',(event,item)=>highlightRelations(item.id)).on('mouseleave',()=>highlightRelations(selectedNodeId))
      .on('focus',(event,item)=>highlightRelations(item.id)).on('blur',()=>highlightRelations(selectedNodeId))
      .call(d3.drag().on('start',(event,item)=>{if(!event.active)graphSimulation.alphaTarget(.2).restart();item.fx=item.x;item.fy=item.y;}).on('drag',(event,item)=>{item.fx=event.x;item.fy=event.y;}).on('end',(event,item)=>{if(!event.active)graphSimulation.alphaTarget(0);item.fx=null;item.fy=null;}));
    const fills=['#d1fae5','#fce7f3','#dbeafe','#fef3c7','#ede9fe','#fef9c3'],strokes=['#065f46','#9d174d','#1e40af','#92400e','#5b21b6','#854d0e'];
    const color=item=>view.clusters.findIndex(cluster=>cluster.id===item.clusterId)%fills.length;
    const radius=item=>graphCollapsed ? 12+Math.min(12,Math.sqrt(item.nodeCount || 1)*2) : 7;
    node.style('--graph-node-color',item=>strokes[color(item)]);
    node.append('circle').attr('class','graph-node-halo').attr('r',item=>radius(item)+6).attr('fill',item=>fills[color(item)]).attr('stroke',item=>strokes[color(item)]).attr('stroke-width',1).attr('aria-hidden','true');
    node.append('circle').attr('class','graph-node-dot').attr('r',radius).attr('fill',item=>fills[color(item)]).attr('stroke',item=>strokes[color(item)]).attr('stroke-width',2);
    node.append('title').text(item=>item.label);
    fitText(node.append('text').attr('dx',item=>graphCollapsed ? 28 : 12).attr('dy',4),item=>item.label,graphCollapsed ? 12 : 8,Math.min(graphCollapsed ? 156 : 100,width-64));
    // Measure after applying actual SVG fonts. Bounds include circle and text,
    // and headings participate in the same rectangle separation as nodes.
    node.each(function(item){const box=this.getBBox();Object.assign(item,{left:box.x-2,right:box.x+box.width+2,top:box.y-2,bottom:box.y+box.height+2});});
    labels.each(function(item){const box=this.getBBox();Object.assign(item,{left:box.x-2,right:box.x+box.width+2,top:box.y-2,bottom:box.y+box.height+2});});
    const centroid=id=>{const members=view.nodes.filter(item=>item.clusterId===id);return members.length ? {x:d3.mean(members,item=>item.x),y:d3.mean(members,item=>item.y)} : anchors.get(id);};
    const draw=()=>{
      headingNodes.forEach(cluster=>{
        const members=view.nodes.filter(item=>item.clusterId===cluster.id);
        cluster.x+=(centroid(cluster.id).x-cluster.x)*.08;
        cluster.y+=((members.length ? d3.min(members,item=>item.y)-32 : anchors.get(cluster.id).y-32)-cluster.y)*.08;
      });
      window.memoGraphLayout.separateLabels([...view.nodes,...headingNodes],width,height);
      link.attr('x1',edge=>edge.source.x).attr('y1',edge=>edge.source.y).attr('x2',edge=>edge.target.x).attr('y2',edge=>edge.target.y);
      linkLabel.attr('x',edge=>(edge.source.x+edge.target.x)/2).attr('y',edge=>(edge.source.y+edge.target.y)/2);
      node.attr('transform',item=>`translate(${item.x},${item.y})`);
      labels.attr('transform',cluster=>`translate(${cluster.x},${cluster.y})`);
      themeLine.attr('x1',edge=>centroid(edge.source).x).attr('y1',edge=>centroid(edge.source).y).attr('x2',edge=>centroid(edge.target).x).attr('y2',edge=>centroid(edge.target).y);
    };
    graphSimulation.on('tick',draw);
    draw();
    graphResizeObserver=new ResizeObserver(()=>{if(Math.abs(container.clientWidth-width)>1 || Math.abs(container.clientHeight-height)>1)renderGraph(data);});
    graphResizeObserver.observe(container);
  } catch(error){console.error(error);container.textContent='图谱这次没能画出来哦～请刷新后再试一次吧～';}
}

document.getElementById('graphCollapseAll').addEventListener('click',()=>{
  if(!graphHistory.length)return;
  graphCollapsed=!graphCollapsed;
  document.getElementById('graphCollapseAll').textContent=graphCollapsed ? '全部展开' : '一键折叠';
  renderGraph(graphHistory[graphIndex]);
});

// Generate graph with full scope coverage and optional batching
async function generateGraph() {
  if (await checkCCAvailable()) return;
  if (await checkCCBusy()) return;
  const btn = document.getElementById('graphRegenBtn');
  btn.disabled = true; btn.textContent = '生成中...';
  showCCTask('生成关联图谱',{type:'graph'});
  try {
    const graphParams = {tags:graphSelectedTags};
    const from=document.getElementById('graphFrom').value,to=document.getElementById('graphTo').value;
    if(from)graphParams.from=from;
    if(to)graphParams.to=to;
    if(from && to && from>to)throw requestError('开始日期不能晚于结束日期','graph date range',400);
    const res = await api('/api/cc/ask', { method: 'POST', body: JSON.stringify({ action: 'graph', params: graphParams }) });
    if(res.graph)window.setAITaskNavigationResult?.('生成关联图谱',{type:'graph',id:res.graph.id,generatedAt:res.graph.generatedAt});
    hideCCTask('生成关联图谱');
    if (res && res.graph) {
      if (!res.graph.nodes || res.graph.nodes.length === 0) {
        showToast('这次还没整理出图谱哦～请再试一次吧～');
      }
      graphHistory.push(res.graph);
      graphIndex = graphHistory.length - 1;
      renderCurrentGraph();
    }
  } catch (err) {
    hideCCTask('生成关联图谱',false);
    if (!err.ccBusy) showToast(err.message);
    console.error(err);
  }
  btn.disabled = false; btn.textContent = '生成图谱';
}

// Navigation
document.getElementById('graphPrev').addEventListener('click', () => {
  if (graphIndex > 0) { graphIndex--; renderCurrentGraph(); }
});
document.getElementById('graphNext').addEventListener('click', () => {
  if (graphIndex < graphHistory.length - 1) { graphIndex++; renderCurrentGraph(); }
});

// Delete current graph
document.getElementById('graphDeleteCurrent').addEventListener('click', () => {
  if (graphHistory.length === 0) return;
  const entry = graphHistory[graphIndex];
  showConfirm('确定删除此图谱？', async () => {
    try {
      await api(`/api/cc/graph/${entry.id}`, { method: 'DELETE' });
      graphHistory.splice(graphIndex, 1);
      if (graphHistory.length === 0) {
        graphSimulation?.stop();graphResizeObserver?.disconnect();
        document.getElementById('graphCollapseAll').disabled=true;
        document.getElementById('graphCoverage').textContent='';
        document.getElementById('graphNav').style.display = 'none';
        document.getElementById('graphContainer').innerHTML =
          '<p style="text-align:center;padding:40px;color:var(--t-text-light)">还没有图谱哦～选好记录，再点「生成图谱」试试吧～</p>';
        document.getElementById('graphInsights').style.display = 'none';
        document.getElementById('graphSummaryPanel').innerHTML =
          '<p class="ga-empty-hint">选择标签后点击"生成图谱"开始</p>';
        document.getElementById('graphDate').textContent = '';
      } else {
        graphIndex = Math.min(graphIndex, graphHistory.length - 1);
        renderCurrentGraph();
      }
    } catch (err) { console.error(err); }
  });
});

document.getElementById('graphClose').addEventListener('click', () => {
  graphSimulation?.stop();graphResizeObserver?.disconnect();
  document.getElementById('graphModal').querySelector('.modal-graph-analysis').classList.remove('graph-fullscreen');
  document.getElementById('graphFullscreen').textContent = '⛶';
  document.getElementById('graphModal').classList.add('hidden');
});
document.getElementById('graphFullscreen').addEventListener('click', () => {
  const panel = document.getElementById('graphModal').querySelector('.modal-graph-analysis');
  const btn = document.getElementById('graphFullscreen');
  panel.classList.toggle('graph-fullscreen');
  btn.textContent = panel.classList.contains('graph-fullscreen') ? '⤡' : '⤢';
});
document.getElementById('graphRegenBtn').addEventListener('click', generateGraph);

// === Weekly Digest ===
let weeklyHistory = [];
let weeklySelectedTags = [];

let weeklyTagExpanded = false;
const WEEKLY_TAG_LIMIT = 8;

function renderWeeklyTagPicker() {
  const container = document.getElementById('weeklyTagPicker');
  const showAll = weeklyTagExpanded || allTags.length <= WEEKLY_TAG_LIMIT;
  const visible = showAll ? allTags : allTags.slice(0, WEEKLY_TAG_LIMIT);
  const hasMore = allTags.length > WEEKLY_TAG_LIMIT;

  let html = visible.map(tag => {
    const ci = tagColorIndex(tag);
    const sel = weeklySelectedTags.includes(tag) ? 'active' : '';
    return `<span class="filter-tag tag-color-${ci} ${sel}" data-tag="${tag}">${tag}</span>`;
  }).join('');
  if (hasMore) {
    html += weeklyTagExpanded
      ? `<button class="filter-expand" data-action="collapse">▲</button>`
      : `<button class="filter-expand" data-action="expand">··· +${allTags.length - WEEKLY_TAG_LIMIT}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.filter-tag').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      weeklySelectedTags = weeklySelectedTags.includes(tag)
        ? weeklySelectedTags.filter(t => t !== tag)
        : [...weeklySelectedTags, tag];
      renderWeeklyTagPicker();
    });
  });
  const expandBtn = container.querySelector('.filter-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => { weeklyTagExpanded = !weeklyTagExpanded; renderWeeklyTagPicker(); });
  }
}

document.getElementById('btnWeeklyDigest').addEventListener('click', async () => {
  weeklySelectedTags = [];
  try { const data = await api('/api/cc/suggestions'); weeklyHistory = data.weeklyDigests || []; } catch { weeklyHistory = []; }
  renderWeeklyTagPicker();
  renderWeeklyHistory();
  document.getElementById('weeklyModal').classList.remove('hidden');
});

document.getElementById('weeklyGenBtn').addEventListener('click', async () => {
  if (await checkCCAvailable()) return;
  if (await checkCCBusy()) return;
  const btn = document.getElementById('weeklyGenBtn');
  btn.disabled = true; btn.textContent = '生成中...';
  showCCTask('生成本周总结',{type:'weekly-digest'});
  try {
    const params = weeklySelectedTags.length > 0 ? { tags: weeklySelectedTags } : {};
    const result = await api('/api/cc/ask', { method: 'POST', body: JSON.stringify({ action: 'weekly-digest', params }) });
    window.setAITaskNavigationResult?.('生成本周总结',{type:'weekly-digest',generatedAt:result.digest?.generatedAt});
    hideCCTask('生成本周总结'); btn.disabled = false; btn.textContent = '生成本周总结';
    const data = await api('/api/cc/suggestions'); weeklyHistory = data.weeklyDigests || [];
    renderWeeklyHistory();
  } catch (err) { hideCCTask('生成本周总结',false); btn.disabled = false; btn.textContent = '生成本周总结'; console.error(err); if(!err.ccBusy)showToast(err.message); }
});

function renderWeeklyHistory() {
  const container = document.getElementById('weeklyHistory');
  if (weeklyHistory.length === 0) { container.innerHTML = '<p style="color:var(--text-light);font-size:13px;text-align:center;padding:20px 0">还没有本周小结哦～点一下「生成本周总结」试试吧～</p>'; return; }
  container.innerHTML = weeklyHistory.map((item, idx) => `
    <div class="tag-summary-item">
      <div class="tag-summary-item-header">
        <span>${formatTime(item.generatedAt)}</span>
        <span class="tag-summary-item-tag" style="background:var(--accent-light);color:var(--accent)">${escapeHtml((item.from && item.to ? `${item.from} — ${item.to}` : `之前的总结 · ${item.week || '未标日期'}`)+(item.tags?.length ? ` · ${item.tags.join('、')}` : ''))}</span>
        <div class="summary-item-actions">
          <button onclick="toggleSummary(this)">▸</button>
          <button class="delete-btn" onclick="deleteWeeklyDigest(${idx})">✕</button>
        </div>
      </div>
      <div class="tag-summary-item-content collapsed-content">${escapeHtml(window.memoMessages.digestText(item,{weekly:true}))}</div>
    </div>
  `).join('');
  container.querySelectorAll('.tag-summary-item').forEach((row,index)=>{row.dataset.generatedAt=weeklyHistory[index].generatedAt || '';});
}

async function deleteWeeklyDigest(idx) {
  showConfirm('确定删除？', async () => {
    try { await api(`/api/cc/weekly-digest/${idx}`, { method: 'DELETE' }); weeklyHistory.splice(idx, 1); renderWeeklyHistory(); } catch (err) { console.error(err); }
  });
}

document.getElementById('weeklyClose').addEventListener('click', () => { document.getElementById('weeklyModal').classList.add('hidden'); });

// === Guide Modal ===
(function setupGuideModal() {
  const modal = document.getElementById('guideModal');
  if (!modal) return;
  const open = () => modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  document.getElementById('btnGuide')?.addEventListener('click', open);
  document.getElementById('guideClose')?.addEventListener('click', close);
  document.getElementById('guideOk')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
})();

// === Blind Box ===
let blindboxPickedTags = [];

document.getElementById('btnBlindBox').addEventListener('click', () => {
  blindboxPickedTags = [];
  document.getElementById('blindboxStep1').classList.remove('hidden');
  document.getElementById('blindboxStep2').classList.add('hidden');
  renderBlindboxPicker();
  document.getElementById('blindBoxModal').classList.remove('hidden');
});

function renderBlindboxPicker() {
  const container = document.getElementById('blindboxTagPicker');
  const allSelected = blindboxPickedTags.length === allTags.length;
  const selectAllBtn = `<span class="blindbox-tag-chip blindbox-select-all ${allSelected ? 'selected' : ''}" id="blindboxSelectAll" style="cursor:pointer">${allSelected ? '取消全选' : '全选'}</span>`;
  container.innerHTML = selectAllBtn + allTags.map(tag => {
    const ci = tagColorIndex(tag); const sel = blindboxPickedTags.includes(tag) ? 'selected' : '';
    return `<span class="blindbox-tag-chip tag-color-${ci} ${sel}" data-tag="${tag}">${getTagEmoji(tag)} ${tag}</span>`;
  }).join('');
  container.querySelector('#blindboxSelectAll').addEventListener('click', () => {
    blindboxPickedTags = allSelected ? [] : [...allTags];
    renderBlindboxPicker();
  });
  container.querySelectorAll('.blindbox-tag-chip[data-tag]').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      blindboxPickedTags = blindboxPickedTags.includes(tag) ? blindboxPickedTags.filter(t => t !== tag) : [...blindboxPickedTags, tag];
      renderBlindboxPicker();
    });
  });
}

document.getElementById('blindboxGoBtn').addEventListener('click', async () => {
  document.getElementById('blindboxStep1').classList.add('hidden');
  document.getElementById('blindboxStep2').classList.remove('hidden');
  document.getElementById('blindboxResult').classList.add('hidden');
  const anim = document.getElementById('blindboxAnimation');
  anim.querySelector('.gift-box').style.animation = 'none';
  requestAnimationFrame(() => { anim.querySelector('.gift-box').style.animation = 'shake 0.6s ease-in-out'; });
  const params = new URLSearchParams();
  if (blindboxPickedTags.length) params.set('tags', blindboxPickedTags.join(','));
  try {
    const memo = await api(`/api/memos/random?${params}`);
    setTimeout(() => {
      document.getElementById('blindboxAnimation').querySelector('.gift-box').textContent = '🎉';
      if (!memo) { document.getElementById('blindboxContent').textContent = '盒子是空的！'; document.getElementById('blindboxTags2').innerHTML = ''; }
      else { document.getElementById('blindboxContent').textContent = memo.content; document.getElementById('blindboxTags2').innerHTML = memo.tags.map(t => `<span class="memo-tag">${t}</span>`).join(''); }
      document.getElementById('blindboxResult').classList.remove('hidden');
    }, 700);
  } catch (err) { console.error(err); }
});

document.getElementById('blindboxAgain').addEventListener('click', () => {
  blindboxPickedTags = [];
  document.getElementById('blindboxAnimation').querySelector('.gift-box').textContent = '🎁';
  document.getElementById('blindboxStep1').classList.remove('hidden');
  document.getElementById('blindboxStep2').classList.add('hidden');
  renderBlindboxPicker();
});

document.getElementById('blindboxClose').addEventListener('click', () => { document.getElementById('blindBoxModal').classList.add('hidden'); });

// === Habit Building ===
let habitPools = [], habitLog = [], habitSelectedPoolId = null, habitCurrentTab = 'pools';
let habitCalYear = new Date().getFullYear(), habitCalMonth = new Date().getMonth() + 1;
let habitGenerating = false; // persists across modal open/close

document.getElementById('btnHabitTrack').addEventListener('click', async () => {
  switchHabitTab('pools');
  loadHabitPools();
  // Restore generating state if still in progress
  if (habitGenerating) {
    document.getElementById('habitUploadProgress').classList.remove('hidden');
    document.getElementById('habitUploadArea').classList.add('hidden');
  }
  document.getElementById('tagSummaryModal').classList.remove('hidden');
});

document.getElementById('tagSummaryClose').addEventListener('click', () => {
  window.habitWishDialog?.close(false);
  document.getElementById('tagSummaryModal').classList.add('hidden');
});

// Tab switching
document.querySelectorAll('.habit-tab').forEach(tab => {
  tab.addEventListener('click', () => switchHabitTab(tab.dataset.tab));
});

function switchHabitTab(name) {
  habitCurrentTab = name;
  document.querySelectorAll('.habit-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('habitPanelPools').classList.toggle('hidden', name !== 'pools');
  document.getElementById('habitPanelDraw').classList.toggle('hidden', name !== 'draw');
  document.getElementById('habitPanelCalendar').classList.toggle('hidden', name !== 'calendar');
  if (name === 'draw') { loadHabitPools(); loadHabitToday(); renderDrawPoolPicker(); }
  if (name === 'calendar') { loadHabitCalendar(); }
}

// === Pool Management ===
async function loadHabitPools() {
  try { const data = await api('/api/habit/pools'); habitPools = data.pools || []; renderHabitPools(); } catch { habitPools = []; renderHabitPools(); }
}

function renderHabitPools() {
  const container = document.getElementById('habitPoolList');
  if (habitPools.length === 0) {
    container.innerHTML = '<p style="color:var(--text-light);font-size:13px;text-align:center;padding:20px 0">还没有卡池，聊聊近期计划，或用一份素材开始吧 🌱</p>';
    return;
  }
  container.innerHTML = habitPools.map(pool => `
    <div class="habit-pool-card" data-id="${pool.id}" style="cursor:pointer">
      <div class="habit-pool-info" onclick="showHabitPoolDetail('${pool.id}')">
        <div class="habit-pool-name">${escapeHtml(pool.name)}</div>
        <div class="habit-pool-count">${pool.habits.length} 条习惯 · ${escapeHtml(pool.description || pool.sourceFile || '')}</div>
      </div>
      <button class="habit-pool-delete" onclick="event.stopPropagation();deleteHabitPool('${pool.id}')">🗑</button>
    </div>
  `).join('');
}

let habitDetailPoolId = null;

function showHabitPoolDetail(poolId) {
  const pool = habitPools.find(p => p.id === poolId);
  if (!pool) return;
  window.habitWishDialog?.close();
  habitDetailPoolId = poolId;
  document.getElementById('habitPoolDetailTitle').textContent = `📚 ${pool.name}`;
  document.getElementById('habitPoolDetailNameInput').value = pool.name;
  renderPoolDetailList(pool);
  document.getElementById('habitPoolDetailModal').classList.remove('hidden');
  document.getElementById('habitPoolDetailClose').focus();
  window.habitWishDialog?.markViewed(pool.id);
  return true;
}

function renderPoolDetailList(pool) {
  const container = document.getElementById('habitPoolDetailList');
  container.innerHTML = pool.habits.map((h, i) => `
    <div class="habit-pool-detail-item" data-idx="${i}">
      <span class="habit-pool-detail-num">${i + 1}.</span>
      <span class="habit-pool-detail-text">${escapeHtml(h)}</span>
      <button class="habit-pool-detail-edit" title="编辑">✏️</button>
    </div>
  `).join('');
  container.querySelectorAll('.habit-pool-detail-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.habit-pool-detail-item');
      const idx = parseInt(item.dataset.idx);
      const textEl = item.querySelector('.habit-pool-detail-text');
      if (item.classList.contains('editing')) return;
      item.classList.add('editing');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'habit-pool-detail-input';
      input.value = pool.habits[idx];
      input.maxLength = 30;
      textEl.replaceWith(input);
      input.focus();
      btn.textContent = '✓';
      const save = async () => {
        const val = input.value.trim();
        if (!val) return;
        pool.habits[idx] = val;
        try {
          await api(`/api/habit/pools/${pool.id}`, { method: 'PUT', body: JSON.stringify({ habits: pool.habits }) });
          renderPoolDetailList(pool);
        } catch (err) { console.error(err); }
      };
      btn.onclick = save;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
  });
}

document.getElementById('habitPoolDetailClose').addEventListener('click', () => {
  document.getElementById('habitPoolDetailModal').classList.add('hidden');
});

document.getElementById('habitPoolDetailNameSave').addEventListener('click', async () => {
  if (!habitDetailPoolId) return;
  const newName = document.getElementById('habitPoolDetailNameInput').value.trim();
  if (!newName) { showToast('还没给卡池起名字哦～写个名字再保存吧～'); return; }
  try {
    await api(`/api/habit/pools/${habitDetailPoolId}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    showToast('已保存');
    document.getElementById('habitPoolDetailTitle').textContent = `📚 ${newName}`;
    loadHabitPools();
  } catch (err) { console.error(err); showToast(err.message); }
});

// Unified material editor: keep text and file drafts while choosing one source.
const habitUploadArea = document.getElementById('habitUploadArea');
const habitFileInput = document.getElementById('habitFileInput');
const habitMaterialText = document.getElementById('habitMaterialText');
let habitMaterialSubmitting = false, habitMaterialFile = null, habitMaterialMode = 'text';

function renderHabitMaterialInput() {
  const usesFile = habitMaterialMode === 'file' && Boolean(habitMaterialFile);
  document.getElementById('habitMaterialModes').classList.toggle('hidden', !habitMaterialFile);
  document.getElementById('habitUseText').setAttribute('aria-pressed', String(!usesFile));
  document.getElementById('habitUseFile').setAttribute('aria-pressed', String(usesFile));
  document.getElementById('habitMaterialTextEditor').classList.toggle('hidden', usesFile);
  document.getElementById('habitMaterialFilePreview').classList.toggle('hidden', !usesFile);
  document.getElementById('habitMaterialFileName').textContent = habitMaterialFile?.name || '';
  document.getElementById('habitMaterialFileMeta').textContent = habitMaterialFile
    ? `${habitMaterialFile.name.split('.').at(-1).toUpperCase()} · ${habitMaterialFile.size < 1024 * 1024 ? Math.max(1, Math.ceil(habitMaterialFile.size / 1024)) + ' KB' : (habitMaterialFile.size / (1024 * 1024)).toFixed(1) + ' MB'}` : '';
  document.getElementById('habitMaterialPick').textContent = habitMaterialFile ? '📎 更换素材' : '📎 上传素材';
  document.getElementById('habitMaterialModeHint').textContent = usesFile
    ? habitMaterialText.value.trim() ? '本次使用文件生成，已输入的文字会保留。' : '本次使用所选文件生成。'
    : habitMaterialFile ? '本次使用文字生成，已选文件会保留。' : '也可以把文件拖到这个框里。';
  habitUploadArea.setAttribute('aria-busy', String(habitMaterialSubmitting));
  for (const id of ['habitMaterialPick', 'habitMaterialRemove', 'habitUseText', 'habitUseFile']) document.getElementById(id).disabled = habitMaterialSubmitting;
  habitMaterialText.readOnly = habitMaterialSubmitting;
  document.getElementById('habitMaterialSubmit').disabled = habitMaterialSubmitting || !(usesFile || habitMaterialText.value.trim());
}

function habitMaterialFileError(file) {
  if (!/\.(txt|zip|docx?|pdf)$/i.test(file.name)) return '请选择 TXT、ZIP、Word 或 PDF 素材';
  if (file.size > 20 * 1024 * 1024) return '素材文件不能超过20 MB，请选一份小一点的素材';
  if (!file.size) return '这份文件是空的，请换一份有内容的素材';
  return '';
}

function selectHabitMaterialFile(file) {
  if (habitMaterialSubmitting) return;
  const error = habitMaterialFileError(file);
  if (error) { habitMaterialError(error);return; }
  habitMaterialError();habitMaterialFile = file;habitMaterialMode = 'file';renderHabitMaterialInput();
}

document.getElementById('habitMaterialPick').addEventListener('click', () => { if (!habitMaterialSubmitting) habitFileInput.click(); });
document.getElementById('habitMaterialRemove').addEventListener('click', () => {
  if (habitMaterialSubmitting) return;
  habitMaterialFile = null;habitMaterialMode = 'text';habitFileInput.value = '';
  habitMaterialError();renderHabitMaterialInput();habitMaterialText.focus();
});
document.getElementById('habitUseText').addEventListener('click', () => {
  if (habitMaterialSubmitting) return;
  habitMaterialMode = 'text';habitMaterialError();renderHabitMaterialInput();habitMaterialText.focus();
});
document.getElementById('habitUseFile').addEventListener('click', () => {
  if (habitMaterialSubmitting || !habitMaterialFile) return;
  habitMaterialMode = 'file';habitMaterialError();renderHabitMaterialInput();
});
habitMaterialText.addEventListener('input', () => { habitMaterialError();renderHabitMaterialInput(); });
habitUploadArea.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();if (!habitMaterialSubmitting) habitUploadArea.classList.add('dragover');
});
habitUploadArea.addEventListener('dragleave', event => { if (!habitUploadArea.contains(event.relatedTarget)) habitUploadArea.classList.remove('dragover'); });
habitUploadArea.addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();habitUploadArea.classList.remove('dragover');
  if (habitMaterialSubmitting) return;
  if (event.dataTransfer.files.length !== 1) { habitMaterialError('一次请选择一份素材文件');return; }
  selectHabitMaterialFile(event.dataTransfer.files[0]);
});
habitFileInput.addEventListener('change', () => {
  if (habitFileInput.files.length) selectHabitMaterialFile(habitFileInput.files[0]);
  habitFileInput.value = '';
});

habitUploadArea.addEventListener('submit', event => {
  event.preventDefault();void generateHabitMaterial();
});

function habitMaterialError(message = '') {
  const error = document.getElementById('habitMaterialError');
  error.textContent = message;error.classList.toggle('hidden', !message);
  if (message) showToast(message);
}

async function generateHabitMaterial() {
  if (habitMaterialSubmitting) return;
  habitMaterialError();
  const file = habitMaterialMode === 'file' ? habitMaterialFile : null;
  const text = file ? '' : habitMaterialText.value.trim();
  if (file && habitMaterialFileError(file)) { habitMaterialError(habitMaterialFileError(file));return; }
  if (!file && (!text || text.length > 200000)) {
    habitMaterialError(text ? '文字不能超过200000字，请缩短后再试' : '请先粘贴文字或选择一份素材');habitMaterialText.focus();return;
  }
  habitMaterialSubmitting = true;renderHabitMaterialInput();
  const progress = document.getElementById('habitUploadProgress');
  let started = false, success = false;
  try {
    if (await checkCCAvailable() || await checkCCBusy()) return;
    habitGenerating = true;
    progress.classList.remove('hidden');habitUploadArea.classList.add('hidden');
    progress.querySelector('.habit-progress-text').textContent = '正在生成习惯卡池…';
    showCCTask('生成习惯卡池',{type:'habit-pool',source:'material'});started = true;
    const options = { method: 'POST' };
    if (file) { const body = new FormData();body.append('materialFile', file);options.body = body; }
    else { options.headers = { 'Content-Type': 'application/json' };options.body = JSON.stringify({ text, sourceName: '粘贴文字' }); }
    const res = await fetch('/api/habit/pools/generate', options);
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[Habit generation]', data.error);
      habitMaterialError([400, 413].includes(res.status) ? data.error || '这份素材暂时无法读取，请换一份试试' : window.memoMessages.errorMessage(data.error, settings.agent));return;
    }
    if (!data.pool) throw new Error('Missing generated pool');
    window.setAITaskNavigationResult?.('生成习惯卡池',{type:'habit-pool',source:'material',id:data.pool.id,generatedAt:data.pool.createdAt});
    success = true;
    if (file) { habitMaterialFile = null;habitMaterialMode = 'text'; }
    else habitMaterialText.value = '';
    await loadHabitPools();showToast(data.pool.sourceTruncated ? '🎉 卡池生成成功～素材较长，已使用前20万字生成' : '🎉 卡池生成成功～');
  } catch (err) {
    habitMaterialError('这次生成没能完成，素材还在，可以再试一次');
    console.error(err);
  } finally {
    if (started) hideCCTask('生成习惯卡池', success);
    habitGenerating = false;habitMaterialSubmitting = false;
    progress.classList.add('hidden');habitUploadArea.classList.remove('hidden');renderHabitMaterialInput();
  }
}
renderHabitMaterialInput();

async function deleteHabitPool(id) {
  showConfirm('确定删除这个卡池？', async () => {
    try { await api(`/api/habit/pools/${id}`, { method: 'DELETE' }); loadHabitPools(); showToast('已删除'); } catch (err) { console.error(err); }
  });
}

// === Draw Habit ===
function renderDrawPoolPicker() {
  const container = document.getElementById('habitDrawPoolPicker');
  if (habitPools.length === 0) {
    container.innerHTML = '<p style="color:var(--text-light);font-size:13px">还没有卡池哦～先聊聊计划或上传素材，做一组自己的习惯卡吧～</p>';
    document.getElementById('habitDrawBtn').disabled = true;
    return;
  }
  container.innerHTML = habitPools.map(pool => `
    <span class="habit-draw-pool-chip ${habitSelectedPoolId === pool.id ? 'active' : ''}" data-id="${pool.id}">
      ${escapeHtml(pool.name)}
    </span>
  `).join('');
  container.querySelectorAll('.habit-draw-pool-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      habitSelectedPoolId = chip.dataset.id;
      document.getElementById('habitDrawBtn').disabled = false;
      renderDrawPoolPicker();
    });
  });
}

function doHabitDraw() {
  document.getElementById('habitDrawStep1').classList.add('hidden');
  document.getElementById('habitDrawStep2').classList.remove('hidden');
  document.getElementById('habitDrawResult').classList.add('hidden');

  api('/api/habit/draw', { method: 'POST', body: JSON.stringify({ poolId: habitSelectedPoolId }) })
    .then(data => {
      document.getElementById('habitDrawContent').textContent = data.log.habit;
      const result = document.getElementById('habitDrawResult');
      result.classList.remove('hidden');
      loadHabitToday();
    })
    .catch(err => { console.error(err); showToast(err.message);document.getElementById('habitDrawStep1').classList.remove('hidden');document.getElementById('habitDrawStep2').classList.add('hidden'); });
}

document.getElementById('habitDrawBtn').addEventListener('click', () => {
  if (!habitSelectedPoolId) return;
  doHabitDraw();
});

document.getElementById('habitDrawAgain').addEventListener('click', () => {
  if (!habitSelectedPoolId) return;
  doHabitDraw();
});

document.getElementById('habitDrawBack').addEventListener('click', () => {
  document.getElementById('habitDrawStep2').classList.add('hidden');
  document.getElementById('habitDrawStep1').classList.remove('hidden');
});

// === Today's Habit ===
async function loadHabitToday() {
  try {
    const data = await api('/api/habit/today');
    const section = document.getElementById('habitTodaySection');
    const list = document.getElementById('habitTodayList');
    if (!data.logs || data.logs.length === 0) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    list.innerHTML = data.logs.map(log => {
      const done = log.completed;
      return `
        <div class="habit-today-card">
          <div class="habit-today-info">
            <span class="habit-today-pool">${escapeHtml(log.poolName || '')}</span>
            <p class="habit-today-text">${escapeHtml(log.habit)}</p>
          </div>
          <button class="habit-today-complete-btn ${done ? 'completed' : ''}" data-id="${log.id}" ${done ? 'disabled' : ''}>${done ? '✓ 已完成' : '✓ 完成'}</button>
        </div>`;
    }).join('');
    list.querySelectorAll('.habit-today-complete-btn:not(.completed)').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/habit/log/${btn.dataset.id}/complete`, { method: 'PUT' });
          btn.textContent = '✓ 已完成';
          btn.classList.add('completed');
          btn.disabled = true;
          showToast('🎉 打卡成功！');
        } catch (err) { console.error(err); }
      });
    });
  } catch { document.getElementById('habitTodaySection').classList.add('hidden'); }
}

// === Calendar ===
async function loadHabitCalendar() {
  document.getElementById('habitCalMonth').textContent = `${habitCalYear}年${habitCalMonth}月`;
  try {
    const data = await api(`/api/habit/calendar?year=${habitCalYear}&month=${habitCalMonth}`);
    renderHabitCalendarGrid(data.calendar || {});
    // Also load log for this month
    const logData = await api(`/api/habit/log?month=${habitCalYear}-${String(habitCalMonth).padStart(2,'0')}`);
    renderHabitCalendarLog(logData.logs || []);
  } catch (err) { console.error(err); }
}

function renderHabitCalendarGrid(calendar) {
  const grid = document.getElementById('habitCalendarGrid');
  grid.innerHTML = `
    <div class="habit-cal-header">日</div><div class="habit-cal-header">一</div>
    <div class="habit-cal-header">二</div><div class="habit-cal-header">三</div>
    <div class="habit-cal-header">四</div><div class="habit-cal-header">五</div>
    <div class="habit-cal-header">六</div>
  `;
  const firstDay = new Date(habitCalYear, habitCalMonth - 1, 1).getDay();
  const daysInMonth = new Date(habitCalYear, habitCalMonth, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // Count completed days in order to cycle tape styles
  const completedDates = Object.keys(calendar).filter(k => calendar[k] === 'completed').sort();
  const tapeClasses = ['tape-sidebar-1', 'tape-sidebar-2', 'tape-sidebar-3'];

  for (let i = 0; i < firstDay; i++) grid.innerHTML += '<div class="habit-cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${habitCalYear}-${String(habitCalMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const status = calendar[dateStr];
    let marker = '';
    const clickable = status ? `data-date="${dateStr}" style="cursor:pointer"` : '';
    if (status === 'completed') {
      const tapeIdx = completedDates.indexOf(dateStr) % tapeClasses.length;
      marker = `<div class="habit-cal-tape ${tapeClasses[tapeIdx]}"></div>`;
    } else if (status === 'drawn') {
      marker = '<div class="habit-cal-dot drawn"></div>';
    } else if (status === 'missed') {
      marker = '<div class="habit-cal-dot missed"></div>';
    }
    grid.innerHTML += `<div class="habit-cal-day${isToday ? ' today' : ''}" ${clickable}><span class="habit-cal-num">${d}</span>${marker}</div>`;
  }
  // Click handler for days with data
  grid.querySelectorAll('.habit-cal-day[data-date]').forEach(day => {
    day.addEventListener('click', () => showHabitDayDetail(day.dataset.date));
  });
}

// === Habit Day Detail ===
async function showHabitDayDetail(date) {
  try {
    const data = await api(`/api/habit/log?date=${date}`);
    const logs = data.logs || [];
    if (logs.length === 0) return;
    const dateParts = date.split('-');
    document.getElementById('habitDayDetailTitle').textContent = `${dateParts[1]}/${dateParts[2]} 打卡详情`;
    document.getElementById('habitDayDetailList').innerHTML = logs.map(log => `
      <div class="habit-day-detail-item">
        <span class="habit-day-detail-pool">${escapeHtml(log.poolName || '')}</span>
        <span class="habit-day-detail-text">${escapeHtml(log.habit)}</span>
        <span class="habit-day-detail-status">${log.completed ? '✅' : '⬜'}</span>
      </div>
    `).join('');
    document.getElementById('habitDayDetailModal').classList.remove('hidden');
  } catch (err) { console.error(err); }
}

document.getElementById('habitDayDetailClose').addEventListener('click', () => {
  document.getElementById('habitDayDetailModal').classList.add('hidden');
});

function renderHabitCalendarLog(logs) {
  const container = document.getElementById('habitCalendarLog');
  if (logs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-light);font-size:13px;text-align:center;padding:16px 0">这个月还没有记录哦～抽一张卡，试试今天的小习惯吧～</p>';
    return;
  }
  container.innerHTML = logs.slice().reverse().map(log => `
    <div class="habit-log-item">
      <span class="habit-log-date">${log.date.slice(5)}</span>
      <span class="habit-log-text">${escapeHtml(log.habit)}</span>
      <span class="habit-log-status">${log.completed ? '✅' : '⬜'}</span>
      <button class="habit-log-delete" onclick="deleteHabitLog('${log.id}')">✕</button>
    </div>
  `).join('');
}

async function deleteHabitLog(id) {
  showConfirm('确定删除这条记录？', async () => {
    try { await api(`/api/habit/log/${id}`, { method: 'DELETE' }); loadHabitCalendar(); loadHabitToday(); } catch (err) { console.error(err); }
  });
}

document.getElementById('habitCalPrev').addEventListener('click', () => {
  habitCalMonth--; if (habitCalMonth < 1) { habitCalMonth = 12; habitCalYear--; }
  loadHabitCalendar();
});
document.getElementById('habitCalNext').addEventListener('click', () => {
  habitCalMonth++; if (habitCalMonth > 12) { habitCalMonth = 1; habitCalYear++; }
  loadHabitCalendar();
});

// === Settings ===
document.getElementById('settingsToggle').addEventListener('click', () => {
  const collapsed = document.getElementById('settingsSection').classList.toggle('section-collapsed');
  document.getElementById('settingsToggle').setAttribute('aria-expanded',String(!collapsed));
});

const themeEmojis = {
  gold:      ['✨', '🌾', '🍯', '🌻', '🍮'],
  cozy:      ['🌿', '☕', '🌱', '🌙', '🍃'],
  macaron:   ['🎀', '🌸', '🍑', '🎯', '🧁'],
  berry:     ['🍇', '🫐', '🍓', '💗', '🎀'],
  slate:     ['🫧', '🪵', '☕', '📅', '🌊'],
  summer:    ['🐚', '🍋', '🌤️', '🌊', '🏝️'],
  candy:     ['🍭', '🌈', '🍬', '⭐', '💫'],
  mintchoc:  ['🍫', '🌿', '🍵', '🤎', '🧸'],
  gelato:    ['🍦', '🌸', '🍑', '🌅', '🎀'],
  blueberry: ['🫐', '🥛', '💙', '❄️', '🧊'],
  spring:    ['🌿', '🍋', '☀️', '🌱', '🍵'],
  mint:      ['🎧', '🫧', '🍃', '🩵', '🌿'],
};
const btnCcIds = ['btnTagSuggest', 'btnTagGraph', 'btnWeeklyDigest', 'btnHabitTrack', 'btnBlindBox'];
const btnCcLabels = ['整理标签', '任务图谱', '本周总结', '习惯养成', '任务盲盒'];

const modalTitleIds = ['tagSuggestTitle', 'graphTitle', 'weeklyTitle', 'tagSummaryTitle', 'blindboxTitle'];
const modalTitleLabels = ['标签整理建议', '关联图谱', '本周总结', '习惯养成', '选择盲盒范围'];

let receivingSharedTheme = false;
function publishThemeSelection(theme, customColors) {
  if (!receivingSharedTheme) window.MemoThemeSync?.publish({theme, ...(customColors ? {customColors} : {})});
}

function applyTheme(theme) {
  clearCustomThemeVars(); // clear any custom inline styles first
  document.documentElement.setAttribute('data-theme', theme === 'gold' ? '' : theme);
  const emojis = themeEmojis[theme] || themeEmojis['gold'];
  btnCcIds.forEach((id, i) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = emojis[i] + ' ' + btnCcLabels[i];
  });
  modalTitleIds.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = emojis[i] + ' ' + modalTitleLabels[i];
  });
  publishThemeSelection(theme);
}

window.MemoThemeSync?.subscribe(selection => {
  const theme = selection.theme === 'pink' ? 'berry' : selection.theme;
  const selector = document.getElementById('themeSelect');
  if (![...selector.options].some(option => option.value === theme)) return;
  settings = {...settings, theme, ...(selection.customColors ? {customColors:selection.customColors} : {})};
  selector.value = theme;
  receivingSharedTheme = true;
  try {
    if (theme === 'custom') applyCustomTheme(settings.customColors || null);
    else applyTheme(theme);
  } finally { receivingSharedTheme = false; }
});

function loadSettings() {
  renderAgentControl();
  const dailyTime = settings.dailyDigestTime || '23:55';
  document.getElementById('dailyTime').value = dailyTime;
  document.getElementById('dailyTimeDisplay').textContent = dailyTime;
  const theme = settings.theme || 'gold';
  document.getElementById('themeSelect').value = theme;
  if (theme === 'custom') {
    applyCustomTheme(settings.customColors || null);
  } else {
    applyTheme(theme);
  }
  tagDisplayOrder = settings.tagOrder || [];
}

// Save time on confirm button click
document.getElementById('dailyTimeConfirm').addEventListener('click', async () => {
  try {
    const newTime = document.getElementById('dailyTime').value;
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      dailyDigestTime: newTime
    }) });
    document.getElementById('dailyTimeDisplay').textContent = newTime;
    showToast('整理时间已保存 ✓');
  } catch (err) { console.error(err); }
});

// Instant theme switch on select change + auto-save
document.getElementById('themeSelect').addEventListener('change', async (e) => {
  const theme = e.target.value;
  if (theme === 'custom') {
    applyCustomTheme(settings.customColors || null);
  } else {
    applyTheme(theme);
  }
  try {
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme }) });
  } catch (err) { console.error(err); }
});

// Theme cycling arrows
document.getElementById('themeNext').addEventListener('click', () => {
  const sel = document.getElementById('themeSelect');
  sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
  sel.dispatchEvent(new Event('change'));
});
document.getElementById('themePrev').addEventListener('click', () => {
  const sel = document.getElementById('themeSelect');
  sel.selectedIndex = (sel.selectedIndex - 1 + sel.options.length) % sel.options.length;
  sel.dispatchEvent(new Event('change'));
});

// === Custom Theme ===
function hexToHSL(hex) {
  let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0, s = 0, l = (max+min)/2;
  if (d > 0) {
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    if (max === r) h = ((g-b)/d+(g<b?6:0))/6;
    else if (max === g) h = ((b-r)/d+2)/6;
    else h = ((r-g)/d+4)/6;
  }
  return [h*360, s*100, l*100];
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const hue2rgb = (p,q,t) => { if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  let r, g, b2;
  if (s === 0) { r = g = b2 = l; } else {
    const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b2 = hue2rgb(p,q,h-1/3);
  }
  return '#' + [r,g,b2].map(x => Math.round(x*255).toString(16).padStart(2,'0')).join('');
}
function lighten(hex, amt) { const [h,s,l] = hexToHSL(hex); return hslToHex(h, s, Math.min(100, l+amt)); }
function darken(hex, amt) { const [h,s,l] = hexToHSL(hex); return hslToHex(h, s, Math.max(0, l-amt)); }
function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function applyCustomTheme(colors) {
  if (!colors) colors = { bg:'#FBF7E9', card:'#FFFFFF', accent:'#E8B84B', text:'#4a3a28', border:'#c8b8a0', deco:'#fce888' };
  const r = document.documentElement.style;
  const accentLight = lighten(colors.accent, 20);
  const accentDark = darken(colors.accent, 15);
  const textLight = lighten(colors.text, 25);
  const bgLight = lighten(colors.bg, 3);
  const decoLight = lighten(colors.deco, 15);
  const decoDark = darken(colors.deco, 15);
  const borderLight = lighten(colors.border, 12);

  // Remove data-theme so custom vars take effect over :root
  document.documentElement.setAttribute('data-theme', 'custom');

  // Theme tokens
  r.setProperty('--t-primary', colors.accent);
  r.setProperty('--t-secondary', accentLight);
  r.setProperty('--t-neutral', colors.border);
  r.setProperty('--t-accent', colors.accent);
  r.setProperty('--t-accent-dark', accentDark);
  r.setProperty('--t-bg', colors.bg);
  r.setProperty('--t-card', colors.card);
  r.setProperty('--t-sidebar', bgLight);
  r.setProperty('--t-text', colors.text);
  r.setProperty('--t-text-light', textLight);
  r.setProperty('--t-text-on-accent', colors.card);
  r.setProperty('--t-border', colors.border);
  r.setProperty('--t-border-light', borderLight);

  // Decoration tokens
  r.setProperty('--d-tape-primary', colors.deco);
  r.setProperty('--d-tape-secondary', decoDark);
  r.setProperty('--d-tape-accent', decoLight);
  r.setProperty('--d-tape-light', lighten(colors.deco, 25));
  r.setProperty('--d-tape-cream', lighten(colors.deco, 18));
  r.setProperty('--d-tape-text', colors.text);
  r.setProperty('--d-tape-text-dark', darken(colors.text, 10));
  r.setProperty('--d-tape-brown', colors.border);
  r.setProperty('--d-tape-brown-dark', darken(colors.border, 12));
  r.setProperty('--d-tape-white-bg', lighten(colors.bg, 2));
  r.setProperty('--d-tape-dot-bg', lighten(colors.deco, 22));
  r.setProperty('--d-star-gold-1', colors.deco);
  r.setProperty('--d-star-gold-2', decoDark);
  r.setProperty('--d-star-yellow-1', decoLight);
  r.setProperty('--d-star-yellow-2', colors.deco);
  r.setProperty('--d-star-brown-1', colors.border);
  r.setProperty('--d-star-brown-2', darken(colors.border, 15));
  r.setProperty('--d-star-light-1', lighten(colors.deco, 22));
  r.setProperty('--d-star-light-2', lighten(colors.deco, 15));
  r.setProperty('--d-clip-gold-1', lighten(colors.deco, 20));
  r.setProperty('--d-clip-gold-2', lighten(colors.deco, 10));
  r.setProperty('--d-clip-gold-border', darken(colors.deco, 8));
  r.setProperty('--d-clip-body-1', lighten(colors.deco, 15));
  r.setProperty('--d-clip-body-2', lighten(colors.deco, 5));
  r.setProperty('--d-paperclip', lighten(colors.deco, 12));
  r.setProperty('--d-wavy', accentDark);
  r.setProperty('--d-digest-bg-1', colors.deco);
  r.setProperty('--d-digest-bg-2', decoDark);
  r.setProperty('--d-kraft-1', lighten(colors.border, 18));
  r.setProperty('--d-kraft-2', lighten(colors.border, 10));
  r.setProperty('--d-paper-cream-1', lighten(colors.bg, 2));
  r.setProperty('--d-paper-cream-2', lighten(colors.bg, -3));
  r.setProperty('--d-paper-grid-1', lighten(colors.bg, 1));
  r.setProperty('--d-paper-grid-2', lighten(colors.bg, -4));
  r.setProperty('--d-paper-plain-1', colors.card);
  r.setProperty('--d-paper-plain-2', lighten(colors.bg, 1));

  // CC character
  r.setProperty('--cc-body', colors.accent);
  r.setProperty('--cc-body-light', accentLight);
  r.setProperty('--cc-body-dark', accentDark);
  r.setProperty('--cc-sparkle', decoLight);
  r.setProperty('--cc-broom', colors.border);
  r.setProperty('--cc-broom-head', colors.deco);
  r.setProperty('--cc-broom-edge', decoDark);

  // Shadow
  r.setProperty('--shadow', `3px 3px 0 ${hexToRgba(colors.border, 0.12)}`);
  r.setProperty('--shadow-hover', `4px 4px 0 ${hexToRgba(colors.border, 0.18)}, 0 4px 12px ${hexToRgba(colors.text, 0.06)}`);

  // Apply emoji fallback
  const emojis = themeEmojis['gold'];
  btnCcIds.forEach((id, i) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = emojis[i] + ' ' + btnCcLabels[i];
  });
  modalTitleIds.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = emojis[i] + ' ' + modalTitleLabels[i];
  });

  // Generate dynamic tape overrides
  injectCustomTapeCSS(colors);
  publishThemeSelection('custom', colors);
}

function injectCustomTapeCSS(c) {
  let el = document.getElementById('customTapeStyle');
  if (!el) { el = document.createElement('style'); el.id = 'customTapeStyle'; document.head.appendChild(el); }
  const [ar,ag,ab] = [parseInt(c.accent.slice(1,3),16), parseInt(c.accent.slice(3,5),16), parseInt(c.accent.slice(5,7),16)];
  const [dr,dg,db] = [parseInt(c.deco.slice(1,3),16), parseInt(c.deco.slice(3,5),16), parseInt(c.deco.slice(5,7),16)];
  const decoLight = lighten(c.deco, 15), decoDark = darken(c.deco, 12);
  const decoLighter = lighten(c.deco, 22), bgLight = lighten(c.bg, 2);
  const T = c.text, S = '[data-theme="custom"]';
  el.textContent = `
${S} .tape-plaid-gold { background: linear-gradient(0deg,rgba(${dr},${dg},${db},0.55) 1px,transparent 1px),linear-gradient(90deg,rgba(${dr},${dg},${db},0.55) 1px,transparent 1px),linear-gradient(0deg,rgba(${dr},${dg},${db},0.28) 2px,transparent 2px),linear-gradient(90deg,rgba(${dr},${dg},${db},0.28) 2px,transparent 2px),linear-gradient(135deg,${decoLight},${c.deco},${decoLight}); background-size:6px 6px,6px 6px,16px 16px,16px 16px,100% 100%; color:${T}; }
${S} .tape-dot-gold { background: radial-gradient(circle 2.5px,rgba(255,255,255,0.88) 70%,transparent 71%),linear-gradient(135deg,${c.deco},${decoDark},${c.deco}); background-size:8px 8px,100% 100%; color:${T}; }
${S} .tape-stripe-gold { background: repeating-linear-gradient(45deg,rgba(${dr},${dg},${db},0.48) 0px,rgba(${dr},${dg},${db},0.48) 2px,transparent 2px,transparent 6px),linear-gradient(135deg,${decoLight},${decoLighter},${decoLight}); color:${T}; }
${S} .tape-1 { background: linear-gradient(90deg,transparent 18px,rgba(${dr},${dg},${db},0.65) 18px,rgba(${dr},${dg},${db},0.65) 22px,transparent 22px),linear-gradient(90deg,transparent 48px,rgba(${dr},${dg},${db},0.65) 48px,rgba(${dr},${dg},${db},0.65) 52px,transparent 52px),linear-gradient(0deg,transparent 6px,rgba(${dr},${dg},${db},0.55) 6px,rgba(${dr},${dg},${db},0.55) 10px,transparent 10px),linear-gradient(135deg,${c.deco},${decoLight}); background-size:60px 26px,60px 26px,60px 26px,100% 100%; color:${T}; }
${S} .tape-2 { background: linear-gradient(135deg,${decoLight},${decoLighter},${decoLight}); color:${T}; }
${S} .tape-3 { background: linear-gradient(90deg,transparent 14px,rgba(${dr},${dg},${db},0.55) 14px,rgba(${dr},${dg},${db},0.55) 17px,transparent 17px),linear-gradient(0deg,transparent 5px,rgba(${dr},${dg},${db},0.45) 5px,rgba(${dr},${dg},${db},0.45) 8px,transparent 8px),linear-gradient(135deg,${decoDark},${c.deco}); background-size:48px 22px,48px 22px,100% 100%; color:${T}; }
${S} .tape-4 { background: linear-gradient(0deg,rgba(${ar},${ag},${ab},0.65) 2px,transparent 2px),linear-gradient(90deg,rgba(${ar},${ag},${ab},0.65) 2px,transparent 2px),linear-gradient(135deg,${decoLighter},${decoLight}); background-size:10px 10px,10px 10px,100% 100%; color:${T}; }
${S} .tape-5 { background: repeating-linear-gradient(0deg,rgba(${dr},${dg},${db},0.25) 0px,rgba(${dr},${dg},${db},0.25) 2px,transparent 2px,transparent 5px),linear-gradient(135deg,${decoLighter},${decoLight}); color:${T}; }
${S} .tape-6 { background: radial-gradient(circle 2px,rgba(${ar},${ag},${ab},0.82) 70%,transparent 71%),linear-gradient(135deg,${decoLight},${decoLighter}); background-size:8px 8px,100% 100%; color:${T}; }
${S} .tape-7 { background: linear-gradient(0deg,rgba(${dr},${dg},${db},0.18) 1px,transparent 1px),linear-gradient(90deg,rgba(${dr},${dg},${db},0.18) 1px,transparent 1px),linear-gradient(0deg,rgba(${dr},${dg},${db},0.30) 2px,transparent 2px),linear-gradient(90deg,rgba(${dr},${dg},${db},0.30) 2px,transparent 2px),linear-gradient(135deg,${decoLighter},${decoLight}); background-size:6px 6px,6px 6px,18px 18px,18px 18px,100% 100%; color:${T}; }
${S} .tape-8 { background: linear-gradient(135deg,${c.accent},${lighten(c.accent,10)},${c.accent}); color:${c.card}; }
${S} .tape-9 { background: radial-gradient(circle 3px,rgba(255,255,255,0.98) 40%,transparent 41%),radial-gradient(circle 1.5px,rgba(${dr},${dg},${db},0.8) 60%,transparent 61%),linear-gradient(135deg,${decoLight},${c.deco}); background-size:12px 12px,12px 12px,100% 100%; color:${T}; }
${S} .tape-10 { background: repeating-linear-gradient(90deg,transparent 0px,transparent 14px,rgba(${dr},${dg},${db},0.25) 14px,rgba(${dr},${dg},${db},0.25) 15px),linear-gradient(135deg,${decoLighter},${decoLight}); color:${T}; }
${S} .tape-sidebar-1 { background: linear-gradient(0deg,rgba(${ar},${ag},${ab},0.50) 2px,transparent 2px),linear-gradient(90deg,rgba(${ar},${ag},${ab},0.50) 2px,transparent 2px),linear-gradient(0deg,rgba(${ar},${ag},${ab},0.25) 1px,transparent 1px),linear-gradient(90deg,rgba(${ar},${ag},${ab},0.25) 1px,transparent 1px),linear-gradient(135deg,${c.deco},${decoLight},${c.deco}); background-size:6px 6px,6px 6px,16px 16px,16px 16px,100% 100%; color:${T}; }
${S} .tape-sidebar-2 { background: radial-gradient(circle 3px,rgba(${dr},${dg},${db},0.80) 70%,transparent 71%),linear-gradient(135deg,${decoLight},${c.deco},${decoLight}); background-size:10px 10px,100% 100%; color:${T}; }
${S} .tape-sidebar-3 { background: repeating-linear-gradient(45deg,rgba(${dr},${dg},${db},0.35) 0px,rgba(${dr},${dg},${db},0.35) 2px,transparent 2px,transparent 6px),repeating-linear-gradient(-45deg,rgba(${dr},${dg},${db},0.22) 0px,rgba(${dr},${dg},${db},0.22) 2px,transparent 2px,transparent 6px),linear-gradient(135deg,${decoLight},${c.deco},${decoLight}); color:${T}; }
${S} .cc-walk-strip::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 8' preserveAspectRatio='none'%3E%3Cpath d='M0 4 Q5 0 10 4 Q15 8 20 4 Q25 0 30 4 Q35 8 40 4' fill='none' stroke='%23${c.accent.slice(1)}' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E"); }
${S} body { background: ${c.bg}; background-image: repeating-linear-gradient(0deg,transparent,transparent 28px,rgba(${ar},${ag},${ab},0.06) 28px,rgba(${ar},${ag},${ab},0.06) 29px); }
${S} .paper-cream .memo-card-body { background: repeating-linear-gradient(0deg,transparent,transparent 22px,rgba(${dr},${dg},${db},0.09) 22px,rgba(${dr},${dg},${db},0.09) 23px),var(--d-paper-cream-1); }
${S} .paper-grid .memo-card-body { background: linear-gradient(0deg,rgba(${dr},${dg},${db},0.10) 1px,transparent 1px),linear-gradient(90deg,rgba(${dr},${dg},${db},0.10) 1px,transparent 1px),var(--d-paper-grid-1); background-size:18px 18px,18px 18px,100% 100%; }
${S} .paper-plain .memo-card-body { background: var(--d-paper-plain-1); }
${S} .paper-kraft .memo-card-body { background: var(--d-kraft-1); }
${S} .digest-bg { background: repeating-linear-gradient(90deg,transparent,transparent 28px,rgba(${dr},${dg},${db},0.40) 28px,rgba(${dr},${dg},${db},0.40) 32px),repeating-linear-gradient(0deg,transparent,transparent 28px,rgba(${dr},${dg},${db},0.35) 28px,rgba(${dr},${dg},${db},0.35) 32px),linear-gradient(155deg,var(--d-digest-bg-1),var(--d-digest-bg-2)); }
  `;
}

function clearCustomThemeVars() {
  const r = document.documentElement.style;
  const props = ['--t-primary','--t-secondary','--t-neutral','--t-accent','--t-accent-dark','--t-bg','--t-card','--t-sidebar','--t-text','--t-text-light','--t-text-on-accent','--t-border','--t-border-light','--d-tape-primary','--d-tape-secondary','--d-tape-accent','--d-tape-light','--d-tape-cream','--d-tape-text','--d-tape-text-dark','--d-tape-brown','--d-tape-brown-dark','--d-tape-white-bg','--d-tape-dot-bg','--d-star-gold-1','--d-star-gold-2','--d-star-yellow-1','--d-star-yellow-2','--d-star-brown-1','--d-star-brown-2','--d-star-light-1','--d-star-light-2','--d-clip-gold-1','--d-clip-gold-2','--d-clip-gold-border','--d-clip-body-1','--d-clip-body-2','--d-paperclip','--d-wavy','--d-digest-bg-1','--d-digest-bg-2','--d-kraft-1','--d-kraft-2','--d-paper-cream-1','--d-paper-cream-2','--d-paper-grid-1','--d-paper-grid-2','--d-paper-plain-1','--d-paper-plain-2','--cc-body','--cc-body-light','--cc-body-dark','--cc-sparkle','--cc-broom','--cc-broom-head','--cc-broom-edge','--shadow','--shadow-hover'];
  props.forEach(p => r.removeProperty(p));
  // Remove dynamic tape CSS
  const el = document.getElementById('customTapeStyle');
  if (el) el.textContent = '';
}

// Custom theme modal
// Read current theme's computed colors as custom theme defaults
function getCurrentThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const toHex = (v) => {
    v = v.trim();
    if (v.startsWith('#')) return v.length === 4 ? '#' + v[1]+v[1]+v[2]+v[2]+v[3]+v[3] : v;
    const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return '#' + [m[1],m[2],m[3]].map(x => parseInt(x).toString(16).padStart(2,'0')).join('');
    return v;
  };
  return {
    bg: toHex(s.getPropertyValue('--t-bg')),
    card: toHex(s.getPropertyValue('--t-card')),
    accent: toHex(s.getPropertyValue('--t-primary')),
    text: toHex(s.getPropertyValue('--t-text')),
    border: toHex(s.getPropertyValue('--t-border-light')),
    deco: toHex(s.getPropertyValue('--d-tape-primary'))
  };
}

let ctBaseColors = null; // stores the base theme colors for reset

document.getElementById('customThemeBtn').addEventListener('click', () => {
  const currentTheme = document.getElementById('themeSelect').value;
  // If already custom and has saved colors, use those; otherwise read from current theme
  const cc = (currentTheme === 'custom' && settings.customColors) ? settings.customColors : getCurrentThemeColors();
  ctBaseColors = { ...cc }; // save for reset
  document.getElementById('ctBg').value = cc.bg;
  document.getElementById('ctCard').value = cc.card;
  document.getElementById('ctAccent').value = cc.accent;
  document.getElementById('ctText').value = cc.text;
  document.getElementById('ctBorder').value = cc.border;
  document.getElementById('ctDeco').value = cc.deco;
  ['ctBg','ctCard','ctAccent','ctText','ctBorder','ctDeco'].forEach(updateCtHex);
  document.getElementById('customThemeModal').classList.remove('hidden');
});
document.getElementById('customThemeClose').addEventListener('click', () => {
  document.getElementById('customThemeModal').classList.add('hidden');
});

// Color format display helpers
function hexToRgbStr(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `${r}, ${g}, ${b}`;
}
function updateCtHex(id) {
  const hex = document.getElementById(id).value.toUpperCase();
  const el = document.querySelector(`.ct-hex[data-for="${id}"]`);
  if (!el) return;
  el.dataset.hex = hex;
  el.dataset.rgb = hexToRgbStr(hex);
  el.textContent = el.dataset.mode === 'rgb' ? el.dataset.rgb : hex;
}

// Toggle hex/rgb on click
document.querySelectorAll('.ct-hex').forEach(el => {
  el.dataset.mode = 'hex';
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dataset.mode = el.dataset.mode === 'hex' ? 'rgb' : 'hex';
    el.textContent = el.dataset.mode === 'rgb' ? el.dataset.rgb : el.dataset.hex;
  });
});

// Live preview as user picks colors
['ctBg','ctCard','ctAccent','ctText','ctBorder','ctDeco'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    updateCtHex(id);
    const colors = {
      bg: document.getElementById('ctBg').value,
      card: document.getElementById('ctCard').value,
      accent: document.getElementById('ctAccent').value,
      text: document.getElementById('ctText').value,
      border: document.getElementById('ctBorder').value,
      deco: document.getElementById('ctDeco').value
    };
    applyCustomTheme(colors);
    document.getElementById('themeSelect').value = 'custom';
  });
});

// Apply & save custom theme
document.getElementById('ctApplyBtn').addEventListener('click', async () => {
  const colors = {
    bg: document.getElementById('ctBg').value,
    card: document.getElementById('ctCard').value,
    accent: document.getElementById('ctAccent').value,
    text: document.getElementById('ctText').value,
    border: document.getElementById('ctBorder').value,
    deco: document.getElementById('ctDeco').value
  };
  try {
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      theme: 'custom', customColors: colors
    }) });
    document.getElementById('themeSelect').value = 'custom';
    showToast('自定义主题已保存 ✓');
    document.getElementById('customThemeModal').classList.add('hidden');
  } catch (err) { console.error(err); }
});

// Reset custom theme
document.getElementById('ctResetBtn').addEventListener('click', () => {
  if (ctBaseColors) {
    // Reset pickers to the base theme colors
    document.getElementById('ctBg').value = ctBaseColors.bg;
    document.getElementById('ctCard').value = ctBaseColors.card;
    document.getElementById('ctAccent').value = ctBaseColors.accent;
    document.getElementById('ctText').value = ctBaseColors.text;
    document.getElementById('ctBorder').value = ctBaseColors.border;
    document.getElementById('ctDeco').value = ctBaseColors.deco;
    ['ctBg','ctCard','ctAccent','ctText','ctBorder','ctDeco'].forEach(updateCtHex);
    // Re-apply live preview with base colors
    applyCustomTheme(ctBaseColors);
    document.getElementById('themeSelect').value = 'custom';
  } else {
    clearCustomThemeVars();
    document.getElementById('themeSelect').value = 'gold';
    applyTheme('gold');
  }
});

// === Scheduled Reminders ===
let storageWorking = false;
const storageMessage = message => { document.getElementById('storageMessage').textContent = message; };

async function storageRequest(url, options = {}) {
  const activity = beginCatMutation(url,options);
  try {
    let response;
    try { response = await fetch(url, { ...options, headers: { 'X-Memo-Storage':'1', ...options.headers } }); }
    catch(error) { throw requestError(error.message,url,0); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw requestError(data.error || '数据操作失败',url,response.status);
    finishCatMutation(activity,true);
    return data;
  } catch (error) {
    finishCatMutation(activity,false);
    throw error;
  }
}

async function loadStorageStatus() {
  const data = await storageRequest('/api/storage/status');
  const count = data.counts;
  document.getElementById('storageStatus').textContent = `保存在这台电脑上 · ${count.memos} 条便签 · ${count.habit_pools} 个卡池 · ${count.habit_logs} 条打卡`;
  document.getElementById('storagePath').textContent = `数据位置：${data.path}`;
  const list = document.getElementById('storageBackupList');
  list.replaceChildren();
  for (const backup of data.backups) {
    const row = document.createElement('div'); row.className = 'storage-backup-row';
    const info = document.createElement('div'); info.className = 'storage-backup-info';
    const label = backup.name.startsWith('auto-') ? '自动备份' : backup.name.startsWith('before-restore-') ? '恢复前备份' : '手动备份';
    const title = document.createElement('div'); title.textContent = `${label} · ${new Date(backup.createdAt).toLocaleString()}`;
    const size = document.createElement('span'); size.textContent = `${(backup.size / 1024).toFixed(1)} KB`;
    info.append(title, size);
    const buttons = document.createElement('div'); buttons.className = 'storage-backup-buttons';
    const download = document.createElement('a'); download.className = 'btn-small'; download.textContent = '下载'; download.href = `/api/storage/backups/${encodeURIComponent(backup.name)}`; download.download = backup.name;
    const restore = document.createElement('button'); restore.className = 'btn-small'; restore.textContent = '恢复'; restore.disabled = storageWorking;
    restore.addEventListener('click', () => confirmStorageRestore({ name:backup.name }));
    buttons.append(download, restore); row.append(info, buttons); list.append(row);
  }
  if (!data.backups.length) list.textContent = '还没有备份哦～点一下「立即备份」，给记录留个副本吧～';
}

function setStorageWorking(value) {
  storageWorking = value;
  document.querySelectorAll('#dataManagementModal button:not(#dataManagementClose)').forEach(button => { button.disabled = value; });
}

function confirmStorageRestore({ name, file }) {
  if (storageWorking) return;
  showConfirm('恢复会替换当前全部数据，包括便签、卡池、打卡和提醒。\n程序会先备份当前数据。恢复成功后将刷新页面，请先保存正在编辑的内容。', async () => {
    if (storageWorking) return;
    setStorageWorking(true); storageMessage('正在找回你的记录哦～请稍等一下～');
    try {
      let options;
      if (file) {
        const body = new FormData(); body.append('backup', file);
        options = { method:'POST', body };
      } else options = { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name}) };
      await storageRequest('/api/storage/restore', options);
      storageMessage('恢复成功，正在刷新…'); window.location.reload();
    } catch (error) { storageMessage(error.message); setStorageWorking(false); }
  });
}

document.getElementById('btnDataManagement').addEventListener('click', async () => {
  document.getElementById('dataManagementModal').classList.remove('hidden');
  storageMessage('');
  try { await loadStorageStatus(); } catch (error) { storageMessage(error.message); }
});
document.getElementById('dataManagementClose').addEventListener('click', () => { document.getElementById('dataManagementModal').classList.add('hidden'); });
document.getElementById('storageBackup').addEventListener('click', async () => {
  if (storageWorking) return;
  setStorageWorking(true); storageMessage('正在创建备份…');
  try { await storageRequest('/api/storage/backup', {method:'POST'}); await loadStorageStatus(); storageMessage('备份完成，可以下载保存。'); }
  catch (error) { storageMessage(error.message); }
  finally { setStorageWorking(false); }
});
document.getElementById('storageUpload').addEventListener('click', () => { document.getElementById('storageBackupFile').click(); });
document.getElementById('storageBackupFile').addEventListener('change', event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return storageMessage('这份备份有点大哦～请选择 100 MB 以内的文件吧～');
  confirmStorageRestore({file});
});

document.getElementById('btnScheduledTasks').addEventListener('click', async () => {
  await renderScheduledList();
  document.getElementById('scheduledModal').classList.remove('hidden');
});
document.getElementById('scheduledClose').addEventListener('click', () => {
  document.getElementById('scheduledModal').classList.add('hidden');
});

document.getElementById('scheduledAddBtn').addEventListener('click', async () => {
  const date = document.getElementById('scheduledDate').value || null;
  const time = document.getElementById('scheduledTime').value;
  const content = document.getElementById('scheduledContent').value.trim();
  if (!time || !content) { showToast('请填写时间和内容'); return; }
  await api('/api/scheduled', { method: 'POST', body: JSON.stringify({ date, time, content }) });
  document.getElementById('scheduledContent').value = '';
  document.getElementById('scheduledDate').value = '';
  await renderScheduledList();
});

async function renderScheduledList() {
  const data = await api('/api/scheduled');
  const list = document.getElementById('scheduledList');
  const tasks = data.tasks || [];
  if (tasks.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:var(--t-text-light);font-size:13px;padding:20px 0">还没有提醒哦～选个时间，给未来的自己留句话吧～</p>';
    return;
  }
  tasks.sort((a, b) => a.time.localeCompare(b.time));
  list.innerHTML = tasks.map(t => {
    const dateLabel = t.date || '每天';
    return `
    <div class="scheduled-item">
      <span class="sch-time">${dateLabel} ${t.time}</span>
      <span class="sch-content">记忆手帐： ${escapeHtml(t.content)}</span>
      <button class="sch-del" data-id="${t.id}" title="删除">&times;</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.sch-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/scheduled/${btn.dataset.id}`, { method: 'DELETE' });
      await renderScheduledList();
    });
  });
}

// Poll for pending reminders every 30s (only in browser, not Electron)
if (!window.electronAPI) {
  setInterval(async () => {
    try {
      const data = await fetch('/api/scheduled/pending').then(r => r.json());
      if (data.pending && data.pending.length > 0) {
        data.pending.forEach(p => {
          showToast(p.message);
        });
      }
    } catch {}
  }, 30000);
}

// === Load Suggestions ===
let _lastDigestSummary = null;
async function loadSuggestions() {
  try {
    const data = await api('/api/cc/suggestions');
    if (data.dailyDigest) {
      const newSummary = `${data.dailyDigest.date || ''}|${data.dailyDigest.generatedAt || ''}|${data.dailyDigest.summary || ''}`;
      if (newSummary !== _lastDigestSummary) {
        _lastDigestSummary = newSummary;
        showDigest(data.dailyDigest, !data.dailyDigest.from);
      }
    } else if (_lastDigestSummary === null) {
      _lastDigestSummary = '';
      showDigest({ date: localDateKey(), summary: '还没有摘要，点击「重新生成」来创建今日摘要吧～', tasks: [] });
    }
  } catch {}
}

// === Go to the exact result belonging to a live task ===
let aiDestinationSequence = 0;
let aiDestinationTaskId = null;
function closeAITaskOverlays(keep) {
  window.habitWishDialog?.close(false);
  document.querySelectorAll('.modal').forEach(modal=>{if(modal.id!==keep)modal.classList.add('hidden');});
}
function destinationNote(container,text='') {
  let note=container.querySelector(':scope > .ai-destination-note');
  if(!note){note=document.createElement('p');note.className='ai-destination-note';note.setAttribute('role','status');container.prepend(note);}
  note.dataset.taskId=aiDestinationTaskId || '';
  note.textContent=text;note.classList.toggle('hidden',!text);
}
function scrollToTaskResult(element) {
  if(!element)return;
  element.scrollIntoView({block:'center',behavior:'auto'});
}
function taskDestinationStatus(task) {
  if(task.status==='running')return '本次任务正在进行，完成后可在这里查看结果。';
  if(task.status==='failed')return window.memoMessages.errorMessage(task.error || '这次任务未能完成，请在这里重试。',task.agent || settings.agent);
  return '';
}
function syncAITaskDestinationStatus(task) {
  if(!task?.id)return;
  document.querySelectorAll('.ai-destination-note').forEach(note=>{
    if(note.dataset.taskId!==task.id)return;
    const text=taskDestinationStatus(task);note.textContent=text;note.classList.toggle('hidden',!text);
  });
}
function syncHabitMaterialTaskState(task) {
  if(task?.target?.type!=='habit-pool' || task.target.source!=='material')return;
  const progress=document.getElementById('habitUploadProgress'),input=document.getElementById('habitUploadArea');
  if(!progress || !input)return;
  const running=task.status==='running';
  if(running){progress.classList.remove('hidden');input.classList.add('hidden');progress.querySelector('.habit-progress-text').textContent='正在生成习惯卡池…';}
  else if(!habitMaterialSubmitting){progress.classList.add('hidden');input.classList.remove('hidden');}
}
window.navigateToAITaskResult=async function(task) {
  const target=task?.target;if(!target?.type)return false;
  const sequence=++aiDestinationSequence,current=()=>sequence===aiDestinationSequence;
  aiDestinationTaskId=task.id || null;
  const status=taskDestinationStatus(task),done=task.status==='completed';
  const missing='这份结果已不存在，或缺少定位信息。可以在这里重新生成。';
  const unavailable='暂时无法读取这份结果，请稍后再试。';
  try {
    if(target.type==='daily-digest'){
      closeAITaskOverlays();const banner=document.getElementById('digestBanner');
      banner.classList.remove('hidden','digest-collapsed');destinationNote(banner.querySelector('.digest-body'),status);scrollToTaskResult(banner);
      let digest=currentDailyDigest;
      if(!target.generatedAt || digest?.generatedAt!==target.generatedAt){const data=await api('/api/cc/suggestions');if(!current())return false;digest=data.dailyDigest;}
      if(done){
        if(!target.generatedAt || digest?.generatedAt!==target.generatedAt){destinationNote(banner.querySelector('.digest-body'),missing);showToast(missing);return false;}
        showDigest(digest,!digest.from);destinationNote(banner.querySelector('.digest-body'));scrollToTaskResult(banner);
      }
      return true;
    }
    if(['weekly-digest','tag-suggestions'].includes(target.type)){
      const weekly=target.type==='weekly-digest',modal=document.getElementById(weekly?'weeklyModal':'tagSuggestModal');
      closeAITaskOverlays(modal.id);modal.classList.remove('hidden');
      destinationNote(modal.querySelector('.modal-content'),status);
      if(weekly){weeklySelectedTags=[];renderWeeklyTagPicker();renderWeeklyHistory();}else renderTagSuggestHistory();
      const data=await api('/api/cc/suggestions');if(!current())return false;
      const history=weekly ? data.weeklyDigests || [] : data.tagSuggestionHistory || [];
      if(weekly){weeklyHistory=history;renderWeeklyHistory();}else{tagSuggestHistory=history;renderTagSuggestHistory();}
      if(done){
        const index=target.generatedAt ? history.findIndex(item=>item.generatedAt===target.generatedAt) : -1;
        if(index<0){destinationNote(modal.querySelector('.modal-content'),missing);showToast(missing);return false;}
        const row=document.getElementById(weekly?'weeklyHistory':'tagSuggestHistory').querySelectorAll('.tag-summary-item')[index];
        row.querySelector('.tag-summary-item-content').classList.remove('collapsed-content');row.querySelector('.summary-item-actions button').textContent='▾';
        destinationNote(modal.querySelector('.modal-content'));scrollToTaskResult(row);
      }else document.getElementById(weekly?'weeklyGenBtn':'tagSuggestGenBtn').focus();
      return true;
    }
    if(target.type==='graph'){
      const modal=document.getElementById('graphModal');closeAITaskOverlays(modal.id);modal.classList.remove('hidden');renderGraphTagPicker();
      destinationNote(modal.querySelector('.modal-content'),status);
      graphSimulation?.stop();graphResizeObserver?.disconnect();
      const container=document.getElementById('graphContainer');container.textContent=done?'正在读取本次图谱…':status;
      document.getElementById('graphNav').style.display='none';
      document.getElementById('graphInsights').style.display='none';
      document.getElementById('graphInsightsContent').replaceChildren();
      document.getElementById('graphSummaryPanel').replaceChildren();
      document.getElementById('graphCoverage').textContent='';
      document.getElementById('graphDate').textContent='';
      document.getElementById('graphCollapseAll').disabled=true;
      const data=await api('/api/cc/suggestions');if(!current())return false;
      graphHistory=data.graphHistory || [];
      if(done){
        const index=target.id ? graphHistory.findIndex(graph=>graph.id===target.id) : -1;
        if(index<0){container.textContent=missing;document.getElementById('graphNav').style.display='none';showToast(missing);return false;}
        graphIndex=index;graphEntryId=null;renderCurrentGraph();destinationNote(modal.querySelector('.modal-content'));scrollToTaskResult(container);
      }
      return true;
    }
    if(['habit-wish','habit-pool'].includes(target.type)){
      closeAITaskOverlays('tagSummaryModal');switchHabitTab('pools');document.getElementById('tagSummaryModal').classList.remove('hidden');
      if(target.type==='habit-wish'){
        window.habitWishDialog?.open();return true;
      }
      syncHabitMaterialTaskState(task);
      destinationNote(document.getElementById('habitPanelPools'),status);
      if(!done){
        if(target.source==='wish'){
          if(task.status==='failed')window.habitWishDialog?.open();
          else scrollToTaskResult(document.getElementById('habitWishProgress').classList.contains('hidden') ? document.getElementById('habitPanelPools') : document.getElementById('habitWishProgress'));
        }else{await loadHabitPools();if(!current())return false;document.getElementById('habitUploadProgress').scrollIntoView({block:'nearest'});}
        return true;
      }
      await loadHabitPools();if(!current())return false;
      if(!target.id || !habitPools.some(pool=>pool.id===target.id)){destinationNote(document.getElementById('habitPanelPools'),missing);showToast(missing);return false;}
      destinationNote(document.getElementById('habitPanelPools'));return Boolean(showHabitPoolDetail(target.id));
    }
    showToast('暂时找不到这项任务的入口，请从侧栏打开对应功能。');return false;
  }catch(error){
    if(current())showToast(unavailable);console.error('[Task destination]',error);return false;
  }
};

// === Close modals on backdrop ===
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
});

// === CC Pixel Scene ===
function initCCScene() {
  const cc = document.getElementById('ccScene');
  if (!cc) return;
  window.CCPixelCat.mount(cc);
  const strip = cc.parentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const labels = { idle:'休息中', thinking:'思考中', coding:'工作中', looking:'查找中', sweeping:'整理中', error:'遇到问题', happy:'开心' };
  let walkPos = 0, paused = false, bounds, geometryKey = '', playingAction = null;
  // The yarn ball extends forty unscaled pixels beyond the normal hit area.
  // Face it into the existing safe lane, and skip it if neither side has room.
  const yarnMargin = () => 40*cc.getBoundingClientRect().width/cc.offsetWidth;
  const yarnFits = (plan, flipped) => (flipped ? plan.bounds.max-plan.position : plan.position-plan.bounds.min) >= yarnMargin();
  const idlePlan = window.CCPixelCatIdle.create({
    now:() => performance.now(),
    animations:window.CCPixelCat.ANIMATIONS,
    canPlayAction(action,plan) { return action.state !== 'yarn' || yarnFits(plan,false) || yarnFits(plan,true); },
    onUpdate(plan) {
      walkPos = plan.position;cc.style.left = walkPos+'px';
      const record = window.CCPixelCat.mount(cc);
      // An idle action can interrupt a walk. Render the action while its saved
      // route position is frozen, then continue the remaining walk afterwards.
      if (plan.action?.state) {
        const action = plan.action;
        if (!playingAction || playingAction.name !== action.name || playingAction.startedAt !== action.startedAt) {
          if (action.state === 'yarn' && !yarnFits(plan,cc.classList.contains('flip'))) cc.classList.toggle('flip');
          window.CCPixelCat.setState(cc,action.state);
          window.CCPixelCat.setProgress(cc,(performance.now()-action.startedAt)/action.duration);
          window.CCPixelCat.play(cc);
          playingAction = action;
        }
      } else if (plan.phase === 'walk' && !plan.action) {
        playingAction = null;
        cc.classList.toggle('flip',plan.direction > 0);
        if (record.state !== 'walk') window.CCPixelCat.setState(cc,'walk');
      } else {
        playingAction = null;
        if (record.state !== 'idle') window.CCPixelCat.setState(cc,'idle');
        window.CCPixelCat.setIdleAction(cc,plan.action?.name || 'rest',plan.action?.startedAt);
      }
    }
  });

  function stopIdle() {
    // Tasks, manual stops and geometry changes invalidate a suspended route too.
    const plan = idlePlan.snapshot(), position = idlePlan.pause();
    playingAction = null;
    if (plan.active || plan.suspended) walkPos = position;
    cc.style.left = walkPos+'px';
  }
  function walkBounds() {
    // Filtering only changes tag rows. Never insert a separate mascot row.
    strip.classList.remove('cat-needs-row');
    strip.style.removeProperty('min-height');
    const parent = strip.getBoundingClientRect(), rect = cc.getBoundingClientRect();
    // The scale is centered on the original hit area. Deriving its inset from
    // widths avoids subpixel left rounding changing the bounds during a walk.
    const inset = (cc.offsetWidth-rect.width)/2, padding = 8;
    const line = getComputedStyle(strip,'::before');
    const waveRight = parent.left+(parseFloat(line.left) || 0)+(parseFloat(line.width) || 0);
    const controls = document.querySelectorAll('.filter-bar .filter-label, .filter-bar .filter-tag, .filter-bar .filter-expand, #clearFilterBtn');
    let gaps = [{ left:Math.max(parent.left+padding,waveRight+padding),right:parent.right-padding }];
    for (const control of controls) {
      if (!control.getClientRects().length) continue;
      const obstacle = control.getBoundingClientRect();
      if (obstacle.bottom <= rect.top || obstacle.top >= rect.bottom) continue;
      const left = obstacle.left-padding, right = obstacle.right+padding;
      // A right-aligned Clear button blocks the right end of a gap; it must
      // not move the left boundary past the entire available walking area.
      gaps = gaps.flatMap(gap => {
        if (right <= gap.left || left >= gap.right) return [gap];
        const remaining = [];
        if (left > gap.left) remaining.push({ left:gap.left,right:left });
        if (right < gap.right) remaining.push({ left:right,right:gap.right });
        return remaining;
      });
    }
    gaps.sort((a,b) => (b.right-b.left)-(a.right-a.left));
    // The tag container reserves a mascot-sized gap even on narrow screens.
    const gap = gaps[0] || { left:parent.right-padding-rect.width,right:parent.right-padding };
    const min = Math.max(padding-inset,Math.min(parent.width-inset-rect.width-padding,gap.left-parent.left-inset));
    const max = Math.max(min,gap.right-parent.left-inset-rect.width);
    return { min,max,canRoam:max-min>=12 };
  }
  function setState(state) {
    const idleAllowed = state === 'idle' && !paused && !reducedMotion.matches && !window._ccActivity.isBusy();
    if (idleAllowed) {
      if (document.hidden) {
        // Returning to this page must continue the wait/walk already in progress.
        const plan = idlePlan.snapshot(), position = idlePlan.suspend();
        playingAction = null;
        if (plan.active || plan.suspended) walkPos = position;
        cc.style.left = walkPos+'px';
        window.CCPixelCat.setState(cc,'idle');
        window.CCPixelCat.setIdleAction(cc,'rest');
      } else if (!idlePlan.snapshot().active) {
        window.CCPixelCat.setState(cc,'idle');
        if (!idlePlan.resumeSuspended()) idlePlan.resume(bounds,bounds.canRoam ? walkPos : Math.max(bounds.min,Math.min(bounds.max,walkPos)));
      }
    } else {
      stopIdle();window.CCPixelCat.setState(cc,state);
      if (state === 'idle') window.CCPixelCat.setIdleAction(cc,'rest');
    }
    cc.setAttribute('aria-label','像素小猫，'+labels[state]+'；空闲时点击互动');
  }
  function reflow() {
    const next = walkBounds(), key = [next.min,next.max,next.canRoam].join(':');
    if (key === geometryKey) return;
    stopIdle();bounds = next;geometryKey = key;
    walkPos = Math.max(bounds.min,Math.min(bounds.max,walkPos));cc.style.left = walkPos+'px';
    setState(window._ccActivity.getState());
  }

  cc.addEventListener('click', () => {
    if (_ccTaskSet.size || aiState.busy || _ccRemoteTask?.status === 'running') {
      window.openAITaskDestination?.();return;
    }
    if (window._ccActivity.isBusy() || window._ccActivity.getState() !== 'idle') return;
    const token = window._ccActivity.begin('cat-greeting','happy',1);
    window._ccActivity.end('cat-greeting',token);
  });
  cc.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      cc.click();
    }
  });

  bounds = walkBounds();geometryKey = [bounds.min,bounds.max,bounds.canRoam].join(':');
  walkPos = bounds.canRoam ? bounds.min : bounds.max;cc.style.left = walkPos+'px';
  window._ccCtrl = {
    stop() { paused = true;setState(window._ccActivity.getState()); },
    resume() { paused = false;setState(window._ccActivity.getState()); },
    getPos() { return walkPos; },
    getIdlePlan() { return idlePlan.snapshot(); },
    setState
  };
  window.addEventListener('resize',reflow);
  const filterBar = document.querySelector('.filter-bar');
  if (filterBar) {
    new MutationObserver(reflow).observe(filterBar,{ childList:true,subtree:true,attributes:true,attributeFilter:['class','style'] });
    new ResizeObserver(reflow).observe(filterBar);
  }
  document.addEventListener('visibilitychange',() => setState(window._ccActivity.getState()));
  reducedMotion.addEventListener('change',() => setState(window._ccActivity.getState()));
  if (window._ccLatestTask !== undefined) receiveCCTask(window._ccLatestTask);
  setState(window._ccActivity.getState());
}

// === Boot ===
init().then(() => { initCCScene(); _scheduleCCIdle(); });
