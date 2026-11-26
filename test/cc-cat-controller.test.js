const test = require('node:test');
const assert = require('node:assert/strict');
const { create, stateForTask } = require('../public/cc-cat-controller');

function fakeClock() {
  let time = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay = 0) {
      const id = ++nextId;
      timers.set(id, { at: time + Math.max(0, delay), callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(duration) {
      const target = time + duration;
      let callbacks = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        if (++callbacks > 1000) throw new Error('Timer loop did not settle');
        const [id, timer] = next;
        timers.delete(id);time = timer.at;timer.callback();
      }
      time = target;
    },
    pending: () => timers.size
  };
}

function fixture(t, options = {}) {
  const clock = fakeClock(), changes = [];
  const controller = create({
    ...clock,
    onChange(state, info) { changes.push({ state, busy: info.busy }); },
    ...options
  });
  t.after(() => controller.destroy());
  return { controller, clock, changes };
}

function task(id, fields = {}) {
  return { id, name: '今日摘要', status: 'running', stage: '正在准备任务', messages: [], ...fields };
}

test('real task stages select waiting, work, search, and organizing animations', () => {
  const examples = [
    [task('one'), 'thinking'],
    [task('one', { stage: '正在等待 Codex 回答' }), 'thinking'],
    [task('one', { stage: '正在连接助手' }), 'thinking'],
    [task('one', { stage: '连接暂时中断，正在重试', messages: [{ text: '旧的回答' }] }), 'thinking'],
    [task('one', { stage: '正在想一想', messages: [{ text: '上一轮的回答' }] }), 'thinking'],
    [task('one', { stage: '正在接收回答' }), 'coding'],
    [task('one', { stage: '', messages: [{ phase: 'answer', text: '已经收到一部分文字' }] }), 'coding'],
    [task('one', { stage: '正在校验并保存结果' }), 'coding'],
    [task('one', { stage: '正在查找便签' }), 'looking'],
    [task('one', { name: '查找便签', stage: '' }), 'looking'],
    [task('one', { name: '整理标签', stage: '正在准备任务' }), 'thinking'],
    [task('one', { name: '整理标签', stage: '正在接收回答', messages: [{ text: '标签' }] }), 'sweeping'],
    [task('one', { stage: '正在归档内容' }), 'sweeping']
  ];
  for (const [input, expected] of examples) {
    assert.equal(stateForTask(input), expected, `${input.name}: ${input.stage}`);
  }
});

test('a request can progress to work and only celebrate after it finishes', t => {
  const { controller, clock, changes } = fixture(t);
  assert.equal(controller.getState(), 'idle');
  assert.equal(controller.isBusy(), false);
  const token = controller.begin('digest', 'thinking');
  assert.ok(Number.isSafeInteger(token));
  assert.equal(controller.getState(), 'thinking');
  assert.equal(controller.isBusy(), true);
  clock.advance(300);
  controller.update('digest', 'coding', token);
  assert.equal(controller.getState(), 'coding');
  clock.advance(300);
  controller.end('digest', token);
  assert.equal(controller.getState(), 'happy');
  assert.equal(controller.isBusy(), false);
  clock.advance(2799);
  assert.equal(controller.getState(), 'happy');
  clock.advance(1);
  assert.equal(controller.getState(), 'idle');
  assert.ok(changes.some(change => change.state === 'coding' && change.busy));
});

test('a fast search remains visible briefly and cancellation does not leave feedback behind', t => {
  const { controller, clock } = fixture(t);
  const first = controller.begin('search', 'looking');
  clock.advance(40);
  controller.end('search', first, { feedback: false });
  clock.advance(559);
  assert.equal(controller.getState(), 'looking', 'a fast result must not flash for a single frame');
  clock.advance(1);
  assert.equal(controller.getState(), 'idle');
  assert.equal(controller.isBusy(), false);

  const second = controller.begin('search', 'looking');
  controller.end('search', second, { success: false });
  controller.cancel('search', second);
  assert.equal(controller.getState(), 'idle');
  clock.advance(5000);
  assert.equal(controller.getState(), 'idle', 'clearing a search also cancels its delayed failure');
});

test('replacement requests reject stale responses and delayed completion timers', t => {
  const { controller, clock } = fixture(t);
  const old = controller.begin('search', 'looking');
  controller.end('search', old, { success: false });
  clock.advance(100);
  const current = controller.begin('search', 'looking');
  assert.notEqual(current, old);
  controller.update('search', 'error', old);
  controller.end('search', old, { success: false });
  controller.cancel('search', old);
  clock.advance(500);
  assert.equal(controller.getState(), 'looking');
  assert.equal(controller.isBusy(), true);
  controller.update('search', 'sweeping', current);
  assert.equal(controller.getState(), 'sweeping');
  controller.end('search', current, { feedback: false });
  clock.advance(100);
  assert.equal(controller.getState(), 'idle');
});

test('higher priority activity wins and completion feedback waits for other work', t => {
  const { controller, clock } = fixture(t);
  const background = controller.begin('background', 'looking', 10);
  const foreground = controller.begin('foreground', 'coding', 30);
  assert.equal(controller.getState(), 'coding');
  clock.advance(600);
  controller.end('foreground', foreground);
  assert.equal(controller.getState(), 'looking', 'a completed operation cannot interrupt another running one');
  clock.advance(4000);
  assert.equal(controller.getState(), 'looking');
  controller.end('background', background, { feedback: false });
  assert.equal(controller.getState(), 'happy', 'the completion feedback starts when it can actually be seen');
  clock.advance(2800);
  assert.equal(controller.getState(), 'idle');
});

test('same priority uses the newest activity and new work preempts old feedback safely', t => {
  const { controller, clock } = fixture(t);
  const first = controller.begin('first', 'looking', 20);
  const second = controller.begin('second', 'sweeping', 20);
  assert.equal(controller.getState(), 'sweeping');
  controller.cancel('second', second);
  assert.equal(controller.getState(), 'looking');
  clock.advance(600);
  controller.end('first', first, { success: false });
  assert.equal(controller.getState(), 'error');
  clock.advance(1000);
  const next = controller.begin('next', 'thinking', 20);
  assert.equal(controller.getState(), 'thinking');
  clock.advance(3000);
  assert.equal(controller.getState(), 'thinking', 'old feedback expiry must not restore idle over new work');
  controller.end('next', next, { feedback: false });
  assert.equal(controller.getState(), 'idle');
});

test('a historical terminal snapshot is quiet and repeated completion snapshots do not replay', t => {
  const { controller, clock, changes } = fixture(t);
  controller.applyTask(task('historical', { status: 'completed', stage: '已完成并保存' }));
  controller.applyTask(task('old-failure', { status: 'failed', error: '旧错误' }));
  assert.equal(controller.getState(), 'idle');
  assert.equal(controller.isBusy(), false);

  controller.applyTask(task('live'));
  assert.equal(controller.getState(), 'thinking');
  controller.applyTask(task('live', { status: 'completed', stage: '已完成并保存' }));
  assert.equal(controller.getState(), 'happy', 'validated remote completion need not wait for the minimum duration');
  const transitions = changes.length;
  clock.advance(1000);
  controller.applyTask(task('live', { status: 'completed', stage: '已完成并保存' }));
  assert.equal(changes.length, transitions);
  clock.advance(1800);
  assert.equal(controller.getState(), 'idle', 'polling the completed task must not extend the feedback');
  controller.applyTask(task('live', { status: 'completed', stage: '已完成并保存' }));
  assert.equal(controller.getState(), 'idle');
});

test('streamed final text remains work until validation, and a failed task shows the question mark state', t => {
  const { controller, clock } = fixture(t);
  controller.applyTask(task('live', { stage: '正在接收回答', messages: [{ phase: 'answer', text: '完整的最终文字' }] }));
  assert.equal(controller.getState(), 'coding');
  assert.equal(controller.isBusy(), true);
  controller.applyTask(task('live', { stage: '正在校验并保存结果', messages: [{ phase: 'answer', text: '完整的最终文字' }] }));
  assert.equal(controller.getState(), 'coding');
  controller.applyTask(task('live', { status: 'failed', stage: '本次任务未完成，结果未保存', error: '结果校验失败' }));
  assert.equal(controller.getState(), 'error');
  assert.equal(controller.isBusy(), false);
  clock.advance(2800);
  assert.equal(controller.getState(), 'idle');
});

test('remote task progress overrides pending requests and busy polling cannot end the remote task', t => {
  const { controller, clock } = fixture(t);
  const local = controller.begin('request', 'thinking', 20);
  controller.setBusy({ busy: true, task: '今日摘要' });
  controller.applyTask(task('live', { stage: '正在接收回答', messages: [{ text: '部分输出' }] }));
  assert.equal(controller.getState(), 'coding');
  controller.setBusy({ busy: false });
  assert.equal(controller.getState(), 'coding', 'an idle status poll does not erase an authoritative running task');
  clock.advance(600);
  controller.end('request', local, { feedback: false });
  assert.equal(controller.getState(), 'coding');
  controller.applyTask(task('live', { stage: '连接暂时中断，正在重试', messages: [{ text: '旧输出' }] }));
  assert.equal(controller.getState(), 'thinking');
  assert.equal(controller.isBusy(), true);
  controller.applyTask(null);
  assert.equal(controller.getState(), 'idle');
  assert.equal(controller.isBusy(), false);
});

test('an old completed task cannot stop a newer running task', t => {
  const { controller } = fixture(t);
  controller.applyTask(task('one'));
  controller.applyTask(task('one', { status: 'completed' }));
  controller.applyTask(task('two', { name: '整理标签', stage: '正在接收回答', messages: [{ text: '正在整理' }] }));
  assert.equal(controller.getState(), 'sweeping');
  controller.applyTask(task('one', { status: 'completed' }));
  assert.equal(controller.getState(), 'sweeping');
  assert.equal(controller.isBusy(), true);
});

test('a stale busy poll cannot cover completion feedback or revive a finished task', t => {
  const { controller, clock } = fixture(t);
  const status = { busy: true, task: '今日摘要', startedAt: 10 };
  controller.setBusy(status);
  controller.applyTask(task('live', { stage: '正在接收回答', messages: [{ text: '输出' }] }));
  clock.advance(100);
  controller.applyTask(task('live', { status: 'completed', finishedAt: 100 }));
  assert.equal(controller.getState(), 'happy');
  assert.equal(controller.isBusy(), false);
  controller.setBusy(status);
  assert.equal(controller.getState(), 'happy', 'a poll sent before the terminal event can arrive afterwards');
  clock.advance(2800);
  controller.setBusy({ busy: false });
  controller.setBusy(status);
  assert.equal(controller.getState(), 'idle', 'an older startedAt remains stale after an idle response');
  controller.setBusy({ ...status, startedAt: 101 });
  assert.equal(controller.getState(), 'thinking', 'a genuinely newer task can still begin');
  assert.equal(controller.isBusy(), true);
});

test('an older short organizing operation cannot replace a validated remote failure', t => {
  const { controller, clock } = fixture(t);
  const organizing = controller.begin('organize', 'sweeping', 5);
  controller.end('organize', organizing);
  clock.advance(100);
  controller.applyTask(task('remote'));
  controller.applyTask(task('remote', { status: 'failed', finishedAt: 100, error: '没有保存结果' }));
  assert.equal(controller.getState(), 'sweeping', 'the short operation still has its minimum display duration');
  clock.advance(500);
  assert.equal(controller.getState(), 'error', 'the delayed low-priority success cannot turn the authoritative failure into happiness');
  assert.equal(controller.isBusy(), false);
  clock.advance(2800);
  assert.equal(controller.getState(), 'idle');
});

test('an HTTP request finishing after its remote task cannot override the remote result', t => {
  const { controller, clock } = fixture(t);
  const request = controller.begin('request', 'thinking', 20);
  controller.applyTask(task('remote', { stage: '正在接收回答', messages: [{ text: '输出' }] }));
  clock.advance(100);
  controller.applyTask(task('remote', { status: 'failed', finishedAt: 100, error: '校验失败' }));
  assert.equal(controller.getState(), 'thinking', 'the pending request remains active until its own callback returns');
  clock.advance(500);
  controller.end('request', request, { success: true });
  assert.equal(controller.getState(), 'error', 'local HTTP cleanup cannot replace a validated remote failure');
  assert.equal(controller.isBusy(), false);
});

test('an older result at the same priority cannot replace a newer result', t => {
  const { controller, clock } = fixture(t);
  const old = controller.begin('older', 'looking', 20);
  clock.advance(100);
  const current = controller.begin('newer', 'coding', 20);
  clock.advance(600);
  controller.end('newer', current, { success: false });
  assert.equal(controller.getState(), 'looking', 'the older request is still active while the newer feedback waits');
  controller.end('older', old, { success: true });
  assert.equal(controller.getState(), 'error', 'callback ordering cannot promote the older success over the newer failure');
});

test('storage maintenance uses organizing and returns quietly to idle', t => {
  const { controller } = fixture(t);
  controller.setBusy({ busy: false, maintenance: true });
  assert.equal(controller.getState(), 'sweeping');
  assert.equal(controller.isBusy(), true);
  controller.setBusy({ busy: false, maintenance: false });
  assert.equal(controller.getState(), 'idle');
  assert.equal(controller.isBusy(), false);
});

test('destroy clears delayed activity and feedback callbacks', t => {
  const { controller, clock, changes } = fixture(t);
  const token = controller.begin('search', 'looking');
  controller.end('search', token);
  assert.ok(clock.pending() > 0);
  controller.destroy();
  assert.equal(clock.pending(), 0);
  const count = changes.length;
  clock.advance(10000);
  assert.equal(changes.length, count);
});
