const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { fixture } = require('./agent-fixture');
const { questionPreview, parseWishResult } = require('../tasks/habit-wish');

test('question previews hide JSON syntax and buffer incomplete escapes', () => {
  const text = JSON.stringify({ question: '你希望“画画”带来什么？\n说说你的"期待" 🌱', options: ['一', '二', '三'] });
  for (let end = 0; end <= text.length; end++) {
    const preview = questionPreview(text.slice(0, end));
    assert.ok(JSON.parse(text).question.startsWith(preview));
    assert.doesNotMatch(preview, /question|options|\\u/);
  }
  assert.equal(questionPreview('{"question":"想\\u4f60'), '想你');
  assert.equal(questionPreview('{"question":"想\\u4f'), '想');
  assert.equal(questionPreview('PRIVATE_THINKING'), '');
});

test('wish result validation rejects malformed cards and repeated content', () => {
  const valid = { name: '小愿望', description: '从小事开始', habits: Array.from({ length: 30 }, (_, i) => '小练习' + i) };
  assert.equal(parseWishResult(JSON.stringify(valid), 'generate').habits.length, 30);
  for (const changed of [ { habits: valid.habits.slice(0, 29) }, { name: '超过五个字的名字' }, { description: '' }, { habits: [...valid.habits.slice(0, 29), '小练习 0。'] }, { habits: [...valid.habits.slice(0, 29), '长'.repeat(26)] } ]) {
    assert.throws(() => parseWishResult(JSON.stringify({ ...valid, ...changed }), 'generate'), /AI 结果校验/);
  }
});

test('wish flow streams across agents, preserves context and saves only complete unique pools', { timeout: 45000 }, async t => {
  const f = fixture(t), dataDir = path.join(f.dir, 'data');fs.mkdirSync(dataDir);
  const defaults = require('../storage/defaults')();defaults['habit_pools.json'].pools = [];
  for (const [file, data] of Object.entries(defaults)) fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data));
  const probe = net.createServer();probe.listen(0, '127.0.0.1');await once(probe, 'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...f.env, PORT: String(port), MEMO_DATA_DIR: dataDir, MEMO_ELECTRON: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM');await once(child, 'close'); } });
  let logs = '';child.stderr.on('data', data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 10000);
    child.stdout.on('data', data => { logs += data;if (logs.includes('Memo server running')) { clearTimeout(timer);resolve(); } });
    child.once('exit', code => { clearTimeout(timer);reject(new Error('Startup ' + code + ': ' + logs)); });
  });
  const calls = () => fs.existsSync(f.capture) ? fs.readFileSync(f.capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function request(route, body, method = body ? 'POST' : 'GET') {
    return fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
  async function turn(body, inspect) {
    const response = await request('/api/habit/wish', body);
    assert.equal(response.status, 200);assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();let buffer = '', result, error;const previews = [];
    while (true) {
      const { value, done } = await reader.read();if (done) break;
      buffer += decoder.decode(value, { stream: true });let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], text = /^data: (.+)$/m.exec(frame)?.[1];
        if (!text) continue;const data = JSON.parse(text);
        if (event === 'question') { previews.push(data.text);if (inspect) { const check = inspect;inspect = null;await check(data.text); } }
        if (event === 'result') result = data;
        if (event === 'error') error = data.error;
        assert.doesNotMatch(JSON.stringify(data), /PRIVATE_THINKING/);
      }
    }
    return { result, error, previews };
  }

  await t.test('invalid answers never launch a model', async () => {
    for (const body of [{}, { stage: 'purpose', wish: '' }, { stage: 'purpose', wish: '字'.repeat(501) }, { stage: 'effort', wish: '画画' }, { stage: 'generate', wish: '画画', purpose: '开心', effort: '几分钟' }]) {
      assert.equal((await request('/api/habit/wish', body)).status, 400);
    }
    assert.equal(calls().length, 0);
  });
  for (const [agent, wish] of [['cc', '学英语'], ['codex', '整理房间'], ['codebuddy', '开始画画']]) {
    await t.test(agent + ' streams questions and forwards all answers into generation', async () => {
      assert.equal((await request('/api/settings', { agent }, 'PUT')).status, 200);
      const purpose = await turn({ stage: 'purpose', wish }, async () => {
        assert.equal((await (await request('/api/ai/status')).json()).busy, true);
        assert.equal((await request('/api/settings', { agent: agent === 'cc' ? 'codex' : 'cc' }, 'PUT')).status, 409);
        assert.equal((await request('/api/habit/wish', { stage: 'purpose', wish: '另一个愿望' })).status, 409);
      });
      assert.equal(purpose.result.options.length, 3);assert.match(purpose.result.question, new RegExp(wish));
      assert.ok(new Set(purpose.previews.map(text => text.length)).size >= 3, 'question must visibly grow before the result');
      assert.equal((await (await request('/api/habit/pools')).json()).pools.length, ['cc', 'codex', 'codebuddy'].indexOf(agent));
      const customPurpose = '其他：想和朋友一起享受这件事';
      const effort = await turn({ stage: 'effort', wish, purpose: customPurpose });
      assert.match(effort.result.question, /和朋友/);
      const body = { stage: 'generate', wish, purpose: customPurpose, effort: '每天十分钟', requestId: randomUUID() };
      const generated = await turn(body);assert.equal(generated.result.pool.habits.length, 30);
      assert.deepEqual(generated.result.pool.wishContext, { wish, purpose: customPurpose, effort: '每天十分钟' });
      assert.equal(calls().at(-1).agent, agent);assert.equal(calls().at(-1).input.effort, body.effort);
      const before = calls().length;
      const retry = await request('/api/habit/wish', body);assert.equal(retry.status, 200);
      assert.equal((await retry.json()).pool.id, generated.result.pool.id);assert.equal(calls().length, before);
      assert.equal((await request('/api/habit/wish', { ...body, effort: '换了回答' })).status, 409);
      const draw = await request('/api/habit/draw', { poolId: generated.result.pool.id });assert.equal(draw.status, 200);
    });
  }
  await t.test('model errors and invalid results leave pools untouched and release the lock', async () => {
    const before = (await (await request('/api/habit/pools')).json()).pools;
    const input = { stage: 'generate', wish: '写作', purpose: '记录日常', effort: '每天五分钟', requestId: randomUUID() };
    for (const mode of ['empty:habit-wish-pool', 'duplicate:habit-wish-pool', 'partial-failure']) {
      fs.writeFileSync(f.mode, mode);const failed = await turn(input);
      assert.ok(failed.error);assert.equal(failed.result, undefined);
      assert.deepEqual((await (await request('/api/habit/pools')).json()).pools, before);
      assert.equal((await (await request('/api/ai/status')).json()).busy, false);
    }
    fs.rmSync(f.mode);assert.equal((await turn(input)).result.pool.habits.length, 30);
  });
  await t.test('a disconnected generation can be recovered without creating another pool', async () => {
    const input = { stage: 'generate', wish: '记录生活', purpose: '保留回忆', effort: '顺手记录', requestId: randomUUID() };
    const before = (await (await request('/api/habit/pools')).json()).pools.length;
    const controller = new AbortController();
    const response = await fetch(base + '/api/habit/wish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    assert.equal(response.status, 200);controller.abort();
    for (let count = 0; count < 200; count++) {
      if (!(await (await request('/api/ai/status')).json()).busy) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const count = calls().length;
    const replay = await request('/api/habit/wish', input);assert.equal(replay.status, 200);
    assert.equal((await replay.json()).pool.generationId, input.requestId);
    assert.equal(calls().length, count);
    assert.equal((await (await request('/api/habit/pools')).json()).pools.length, before + 1);
  });
});
