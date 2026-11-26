const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const AdmZip = require('adm-zip');
const { fixture } = require('./agent-fixture');
const { docx, pdf } = require('./habit-material-fixtures');
const { MAX_FILE_BYTES, MAX_TEXT_CHARS } = require('../tasks/habit-material');

test('all material input methods generate and persist pools, validate before AI, and clean uploads', { timeout: 30000 }, async t => {
  const f = fixture(t), dataDir = path.join(f.dir, 'data');fs.mkdirSync(dataDir);
  const seed = require('../storage/defaults')();seed['settings.json'].agent = 'cc';seed['habit_pools.json'].pools = [];
  for (const [name, value] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
  const probe = net.createServer();probe.listen(0, '127.0.0.1');await once(probe, 'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...f.env, MEMO_DATA_DIR: dataDir, MEMO_ELECTRON: '1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';child.stderr.on('data', chunk => logs += chunk);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM');await once(child, 'close'); } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 10000);
    child.stdout.on('data', chunk => { logs += chunk;if (logs.includes('Memo server running')) { clearTimeout(timer);resolve(); } });
    child.once('exit', code => { clearTimeout(timer);reject(new Error('Server exit ' + code + ': ' + logs)); });
  });
  const calls = () => fs.existsSync(f.capture) ? fs.readFileSync(f.capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const pools = async () => (await (await fetch(base + '/api/habit/pools')).json()).pools;
  async function send(body, status = 200, json = false) {
    const response = await fetch(base + '/api/habit/pools/generate', { method: 'POST', body: json ? JSON.stringify(body) : body, ...(json ? { headers: { 'Content-Type': 'application/json' } } : {}) });
    const result = await response.json();assert.equal(response.status, status, JSON.stringify(result));
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'habit_upload')), [], 'Temporary uploads must be removed before response: ' + (result.error || result.pool?.sourceFile || '(text)'));
    return result;
  }
  const upload = (name, buffer, status = 200, field = 'materialFile') => { const body = new FormData();body.append(field, new Blob([buffer]), name);return send(body, status); };

  await t.test('real file formats and original ZIP field reach the model with extracted text and persist', async () => {
    const zip = new AdmZip();zip.addFile('skills/book.md', Buffer.from('观察窗边光线，整理桌面，阅读一页。'));
    const samples = [
      ['笔记🌿.txt', Buffer.from('观察窗边光线，整理桌面，阅读一页。')],
      ['skills.zip', zip.toBuffer()],
      ['练习.docx', docx()],
      ['练习.doc', fs.readFileSync(path.join(__dirname, 'fixtures/habit-material/observations.doc'))],
      ['阅读.pdf', pdf()]
    ];
    for (const [name, buffer] of samples) {
      const { pool } = await upload(name, buffer);
      assert.equal(pool.habits.length, 30);assert.equal(new Set(pool.habits).size, 30);assert.equal(pool.sourceFile, name);
      assert.ok(calls().at(-1).input.book.includes('整理桌面'), name + ': source content must reach the model');
      assert.ok((await pools()).find(saved => saved.id === pool.id));
    }
    assert.equal((await upload('legacy.zip', zip.toBuffer(), 200, 'zipFile')).pool.habits.length, 30);
  });
  await t.test('pasted JSON exceeding 100KB and multipart text generate through the same pipeline', async () => {
    const text = '每日整理桌面。'.repeat(10000);
    const { pool } = await send({ text, sourceName: '近期计划' }, 200, true);
    assert.equal(pool.sourceFile, '近期计划');assert.equal(pool.sourceType, 'text');assert.equal(pool.habits.length, 30);
    assert.ok(calls().at(-1).input.book.includes(text));
    const body = new FormData();body.append('text', '每天读一页，记录窗边光线。');
    assert.equal((await send(body)).pool.sourceFile, '粘贴文字');
  });
  await t.test('unsupported, corrupt, empty, mixed and oversized inputs return JSON and never invoke AI or save', async () => {
    const before = await pools(), count = calls().length;
    for (const [name, buffer] of [['empty.txt', Buffer.from('  ')], ['empty.zip', new AdmZip().toBuffer()], ['broken.docx', Buffer.from('not docx')], ['broken.pdf', Buffer.from('%PDF-bad')], ['scan.pdf', pdf('')], ['image.png', Buffer.from('png')]]) {
      assert.ok((await upload(name, buffer, 400)).error);
    }
    await upload('too-large.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 'a'), 413);
    await send({ text: '字'.repeat(MAX_TEXT_CHARS + 1) }, 413, true);
    await send({ text: '字'.repeat(400000) }, 413, true);
    await send({ text: '  ' }, 400, true);
    const both = new FormData();both.append('materialFile', new Blob(['notes']), 'notes.txt');both.append('text', 'other');
    await send(both, 400);
    const twice = new FormData();twice.append('materialFile', new Blob(['notes']), 'one.txt');twice.append('zipFile', new Blob(['notes']), 'two.txt');
    await send(twice, 400);
    assert.equal(calls().length, count);assert.deepEqual(await pools(), before);
  });
  await t.test('invalid generated cards do not save and retry succeeds', async () => {
    const before = await pools();fs.writeFileSync(f.mode, 'duplicate:habit-pool');
    try { assert.match((await send({ text: '整理桌面，记录观察。' }, 500, true)).error, /重复/); }
    finally { fs.rmSync(f.mode, { force: true }); }
    assert.deepEqual(await pools(), before);
    assert.equal((await send({ text: '整理桌面，记录观察。' }, 200, true)).pool.habits.length, 30);
  });
  await t.test('a concurrent generation is busy and still removes its uploaded file', async () => {
    fs.writeFileSync(f.mode, 'slow');
    const pending = upload('generating.txt', Buffer.from('阅读一页。'));
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await (await fetch(base + '/api/ai/status')).json();if (status.busy) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.deepEqual(fs.readdirSync(path.join(dataDir, 'habit_upload')), [], 'Parsed uploads must already be removed while the model is generating');
      assert.equal((await upload('busy.txt', Buffer.from('阅读另一页。'), 409)).busy, true);
      await pending;
    } finally { fs.rmSync(f.mode, { force: true }); }
  });
});
