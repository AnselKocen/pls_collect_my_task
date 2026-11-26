const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store, FILES } = require('../storage/store');
const { APPLICATION_ID, VERSION } = require('../storage/schema');
const defaults = require('../storage/defaults');

function setup(t) {
  // Quotes exercise bound VACUUM filenames; this must never become interpolated SQL.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-snapshot-'"));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const store = new Store(dir, { automaticBackup: false });
    stores.push(store);
    return store;
  };
  return { dir, store: open(), open };
}

function readSnapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const reader = Object.create(Store.prototype);
    reader.db = db;
    reader.checkIntegrity(db);
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, VERSION);
    return reader.exportLegacy();
  } finally { db.close(); }
}

function initialDocuments() {
  const documents = defaults();
  documents['memos.json'] = {
    memos: [{ id: 'before-note', content: '快照之前 🌿', tags: ['之前'], createdAt: '2026-11-25T01:00:00Z', extra: { preserved: true } }],
    extra: 'preserved'
  };
  documents['habit_log.json'] = { logs: [{ id: 'before-log', date: '2026-11-25', habit: '记录', completed: false }] };
  documents['scheduled_tasks.json'] = {
    tasks: [{ id: 'before-reminder', time: '12:34', date: '2099-01-01', content: '未来提醒' }],
    pending: [{ id: 'pending-before', message: '等待消费' }]
  };
  documents['ai_suggestions.json'] = {
    dailyDigest: { summary: '之前摘要' }, graphHistory: [], custom: { retained: true }
  };
  return documents;
}

test('snapshots fix all six sections before later writes in DELETE and WAL modes', async t => {
  for (const mode of ['DELETE', 'WAL']) await t.test(mode, async t => {
    const { store } = setup(t);
    store.db.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;`);
    const documents = initialDocuments();
    for (const [section, filename] of Object.entries(FILES)) store.write(section, documents[filename]);
    const before = store.exportLegacy();
    const pending = store.createBackup();
    assert.equal(typeof pending.then, 'function'); // Preserve the existing Promise API.
    store.transaction(() => {
      store.update('memos', d => {
        d.memos[0].content = '快照之后编辑';
        d.memos.push({ id: 'late-note', content: '快照之后新增', tags: [] });
      });
      store.update('settings', d => { d.theme = 'late-theme'; });
      store.update('suggestions', d => { d.graphHistory.push({ id: 'late-ai-result', nodes: [], edges: [] }); });
      store.update('pools', d => { d.pools[0].habits.push('快照之后新增习惯'); });
      store.update('logs', d => { d.logs[0].completed = true; });
      store.update('scheduled', d => { d.tasks = []; d.pending = []; });
    });
    const after = store.exportLegacy(), saved = await pending;
    assert.notDeepEqual(after, before);
    assert.deepEqual(readSnapshot(store.backupPath(saved.name)), before);
    assert.deepEqual(store.exportLegacy(), after);
    store.checkIntegrity(store.db);
    assert.ok(!fs.readdirSync(store.backupDir).some(name => name.endsWith('.partial')));
  });
});

test('a later writer on another connection is retained online and excluded from the snapshot', async t => {
  const { store, open } = setup(t), writer = open();
  const before = store.exportLegacy(), pending = store.createBackup();
  writer.update('memos', d => { d.memos.push({ id: 'other-connection', content: '之后提交', tags: [] }); });
  const saved = await pending;
  assert.deepEqual(readSnapshot(store.backupPath(saved.name)), before);
  assert.equal(store.read('memos').memos.at(-1).id, 'other-connection');
  store.checkIntegrity(store.db);
});

test('repeated backup/write overlap has a fixed cutoff and never loses writes', async t => {
  const { store } = setup(t);
  store.update('memos', d => {
    d.memos = Array.from({ length: 300 }, (_, i) => ({ id: 'initial-' + i, content: '虚构内容🌿'.repeat(150), tags: [] }));
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const before = store.exportLegacy(), pending = store.createBackup();
    store.update('memos', d => { d.memos.push({ id: 'after-' + attempt, content: '截止之后', tags: [] }); });
    const saved = await pending;
    assert.deepEqual(readSnapshot(store.backupPath(saved.name)), before, 'snapshot cutoff attempt ' + attempt);
    assert.equal(store.read('memos').memos.length, 301 + attempt);
  }
  store.checkIntegrity(store.db);
  assert.ok(!fs.readdirSync(store.backupDir).some(name => name.endsWith('.partial')));
});

test('an already scheduled asynchronous AI save remains online after the snapshot cutoff', async t => {
  const { store } = setup(t), before = store.exportLegacy();
  const lateSave = Promise.resolve().then(() => store.update('suggestions', d => {
    d.dailyDigest = { summary: '在途任务之后提交的结果' };
  }));
  const pending = store.createBackup();
  await lateSave;
  const saved = await pending;
  assert.deepEqual(readSnapshot(store.backupPath(saved.name)), before);
  assert.equal(store.read('suggestions').dailyDigest.summary, '在途任务之后提交的结果');
});

test('an unwritable backup destination rejects without affecting later writes or retries', async t => {
  const { store } = setup(t);
  fs.mkdirSync(store.backupDir);
  fs.chmodSync(store.backupDir, 0o555);
  try { await assert.rejects(store.createBackup(), /open|readonly|permission|unable/i); }
  finally { fs.chmodSync(store.backupDir, 0o755); }
  assert.deepEqual(fs.readdirSync(store.backupDir), []);
  store.update('memos', d => { d.memos.push({ id: 'after-failure', content: '失败后正常保存', tags: [] }); });
  const saved = await store.createBackup();
  assert.deepEqual(readSnapshot(store.backupPath(saved.name)), store.exportLegacy());
});

test('a rejected snapshot check removes the partial file and leaves the writer usable', async t => {
  const { store } = setup(t), before = store.exportLegacy(), checkIntegrity = store.checkIntegrity;
  store.checkIntegrity = () => { throw new Error('controlled snapshot validation failure'); };
  try { await assert.rejects(store.createBackup(), /controlled snapshot/); }
  finally { store.checkIntegrity = checkIntegrity; }
  assert.deepEqual(fs.readdirSync(store.backupDir), []);
  assert.deepEqual(store.exportLegacy(), before);
  store.update('settings', d => { d.theme = 'after-failure'; });
  const saved = await store.createBackup();
  assert.equal(readSnapshot(store.backupPath(saved.name))['settings.json'].theme, 'after-failure');
});

test('restoring a fixed snapshot still creates a complete before-restore safety backup', async t => {
  const { store } = setup(t), before = store.exportLegacy(), pending = store.createBackup();
  store.update('memos', d => { d.memos = [{ id: 'late', content: '恢复前的后续修改', tags: [] }]; });
  store.update('settings', d => { d.theme = 'later'; });
  const after = store.exportLegacy(), saved = await pending;
  const restored = await store.restore(store.backupPath(saved.name));
  assert.deepEqual(store.exportLegacy(), before);
  assert.deepEqual(readSnapshot(store.backupPath(restored.safetyBackup)), after);
  await store.restore(store.backupPath(restored.safetyBackup));
  assert.deepEqual(store.exportLegacy(), after);
});
