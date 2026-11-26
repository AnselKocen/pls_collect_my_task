(function (global) {
  'use strict';

  const STATES = new Set(['idle', 'thinking', 'coding', 'looking', 'sweeping', 'happy', 'error']);
  const REMOTE = 'remote-task';
  const BACKEND = 'backend-busy';

  function stateForTask(task = {}) {
    if (task.status === 'completed') return 'happy';
    if (task.status === 'failed') return 'error';
    const stage = String(task.stage || '');
    const name = String(task.name || task.task || '');
    // A retry can retain earlier text. The current stage takes precedence.
    if (/等待|准备|连接|重试|思考|想一想|waiting|prepar|connect|retry|thinking/i.test(stage)) return 'thinking';
    if (/查找|检索|搜索|读取|search|retriev|lookup|reading/i.test(stage + ' ' + name)) return 'looking';
    if (/整理|归档|分类|标签|organiz|archiv|sort|\btags?\b/i.test(stage + ' ' + name)) return 'sweeping';
    if (/接收|生成|校验|验证|保存|执行|receiv|generat|validat|saving|execut/i.test(stage)) return 'coding';
    if (Array.isArray(task.messages) && task.messages.some(message => typeof message.text === 'string' && message.text.trim())) return 'coding';
    return 'thinking';
  }

  function create(options = {}) {
    const onChange = options.onChange || (() => {});
    const schedule = options.setTimeout || ((callback, delay) => global.setTimeout(callback, delay));
    const unschedule = options.clearTimeout || (timer => global.clearTimeout(timer));
    const now = options.now || (() => Date.now());
    const feedbackDuration = Math.max(0, options.feedbackDuration ?? 2800);
    const minActivityDuration = Math.max(0, options.minActivityDuration ?? 600);
    const activities = new Map();
    const tasks = new Map();
    let serial = 0, feedback = null, destroyed = false;
    let state = 'idle', busy = false, initialized = false;
    let remoteId = null, busySignature = null, completedBusySignature = null;
    let completedAt = 0;

    function selected() {
      let winner = null;
      for (const activity of activities.values()) {
        if (!winner || activity.priority > winner.priority ||
          (activity.priority === winner.priority && activity.token > winner.token)) winner = activity;
      }
      return winner;
    }
    function publicActivity(activity) {
      return activity ? { id:activity.id, state:activity.state, token:activity.token, priority:activity.priority } : null;
    }
    function snapshot() {
      return {
        state, busy, active:publicActivity(selected()),
        activities:[...activities.values()].map(publicActivity),
        feedback:feedback?.state || null
      };
    }
    function clearFeedback() {
      if (feedback?.timer != null) unschedule(feedback.timer);
      feedback = null;
    }
    function notify() {
      const winner = selected();
      const nextBusy = Boolean(winner);
      const nextState = winner?.state || feedback?.state || 'idle';
      // Feedback blocked by an ongoing task gets its full display time later.
      if (!winner && feedback && feedback.timer == null) {
        const current = feedback;
        current.timer = schedule(() => {
          if (destroyed || feedback !== current) return;
          feedback = null;notify();
        }, feedbackDuration);
      }
      const changed = !initialized || state !== nextState || busy !== nextBusy;
      state = nextState;busy = nextBusy;initialized = true;
      if (changed) onChange(state, snapshot());
    }
    function remove(activity) {
      if (!activity || activities.get(activity.id) !== activity) return false;
      if (activity.timer != null) unschedule(activity.timer);
      activities.delete(activity.id);
      return true;
    }
    function queueFeedback(success, activity) {
      // Late completions must not replace a more authoritative result, nor a
      // result from a newer operation at the same priority.
      if (feedback && (feedback.priority > activity.priority ||
        (feedback.priority === activity.priority && feedback.token >= activity.token))) return;
      clearFeedback();
      feedback = { state:success ? 'happy' : 'error', priority:activity.priority, token:activity.token, timer:null };
    }
    function begin(id, nextState = 'thinking', priority = 20) {
      if (destroyed) return null;
      remove(activities.get(id));
      clearFeedback();
      const activity = {
        id, token:++serial, state:STATES.has(nextState) ? nextState : 'thinking',
        priority:Number.isFinite(priority) ? priority : 20,
        startedAt:now(), timer:null, ending:false
      };
      activities.set(id, activity);notify();
      return activity.token;
    }
    function update(id, nextState, token) {
      if (destroyed) return false;
      const activity = activities.get(id);
      if (!activity || activity.ending || (token != null && activity.token !== token)) return false;
      activity.state = STATES.has(nextState) ? nextState : 'thinking';
      notify();return true;
    }
    function end(id, token, result = {}) {
      if (destroyed) return false;
      const activity = activities.get(id);
      if (!activity || activity.ending || (token != null && activity.token !== token)) return false;
      activity.ending = true;
      const finish = () => {
        if (destroyed || !remove(activity)) return;
        if (result.feedback !== false) queueFeedback(result.success !== false, activity);
        notify();
      };
      const remaining = Math.max(0, minActivityDuration - (now() - activity.startedAt));
      if (remaining) activity.timer = schedule(finish, remaining);
      else finish();
      return true;
    }
    function cancel(id, token) {
      if (destroyed) return false;
      const activity = activities.get(id);
      if (!activity || (token != null && activity.token !== token)) return false;
      remove(activity);notify();return true;
    }
    function rememberTask(id) {
      if (!tasks.has(id)) {
        tasks.set(id, { running:false, terminal:false });
        // The backend retains only its latest task; keep a small dedup history.
        while (tasks.size > 64) tasks.delete(tasks.keys().next().value);
      }
      return tasks.get(id);
    }
    function applyTask(task) {
      if (destroyed) return;
      if (!task?.id) {
        remoteId = null;remove(activities.get(REMOTE));notify();return;
      }
      const record = rememberTask(task.id);
      if (task.status === 'running') {
        if (record.terminal) return;
        record.running = true;
        if (remoteId !== task.id || !activities.has(REMOTE)) {
          remoteId = task.id;
          completedBusySignature = null;
          record.token = begin(REMOTE, stateForTask(task), 30);
        } else update(REMOTE, stateForTask(task));
        return;
      }
      if (!['completed', 'failed'].includes(task.status) || record.terminal) return;
      record.terminal = true;
      // Loading a page must not celebrate an old result retained by the server.
      if (!record.running || remoteId !== task.id) return;
      remoteId = null;
      remove(activities.get(REMOTE));
      // A busy-status poll can lag the terminal task event by one round trip.
      completedBusySignature = busySignature;
      completedAt = Number(task.finishedAt) || now();
      remove(activities.get(BACKEND));
      queueFeedback(task.status === 'completed', { priority:30, token:record.token });notify();
    }
    function setBusy(status = {}) {
      if (destroyed) return;
      if (!status.busy && !status.maintenance) {
        busySignature = null;completedBusySignature = null;
        remove(activities.get(BACKEND));notify();return;
      }
      const signature = String(status.startedAt || '') + ':' + String(status.task || '') + ':' + Boolean(status.maintenance);
      if ((completedBusySignature != null && signature === completedBusySignature) ||
        (completedAt && status.startedAt && Number(status.startedAt) <= completedAt && !status.maintenance)) return;
      busySignature = signature;
      const nextState = status.maintenance ? 'sweeping' : stateForTask({ name:status.task, stage:status.stage, messages:[] });
      if (activities.has(BACKEND)) update(BACKEND, nextState);
      else begin(BACKEND, nextState, 10);
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const activity of activities.values()) if (activity.timer != null) unschedule(activity.timer);
      activities.clear();tasks.clear();clearFeedback();
      notify();
    }
    notify();
    return {
      begin, update, end, cancel, applyTask, setBusy,
      getState:() => state, isBusy:() => busy, snapshot, destroy
    };
  }

  const api = { create, stateForTask };
  global.CCPixelCatController = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
