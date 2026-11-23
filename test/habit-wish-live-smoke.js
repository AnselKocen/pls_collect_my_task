// Explicit manual test. Uses the user's real selected CLI with fictional answers
// and an isolated temporary database; never reads or changes the user's pools.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { resolveCli, getSelectableAgent } = require('../agents');
const project = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wish-real-'));
const agent = process.env.MEMO_TEST_AGENT || 'codex';
const report = { agent, fictionalWish: '我想开始画画', turns: [] };
let child;

async function main() {
  getSelectableAgent(agent);
  const configDir = process.env.MEMO_CONFIG_DIR || project;
  const cli = resolveCli(agent, { configDir });assert.ok(cli, 'No real CLI is available for ' + agent);
  report.cli = cli;
  const data = require('../storage/defaults')();data['habit_pools.json'].pools = [];data['memos.json'].memos = [];
  data['settings.json'].agent = agent;
  for (const [file, value] of Object.entries(data)) fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  const probe = net.createServer();probe.listen(0, '127.0.0.1');await once(probe, 'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, MEMO_CONFIG_DIR: configDir, MEMO_DATA_DIR: root, MEMO_ELECTRON: '1', PORT: String(port) };
  for (const key of Object.keys(env)) if (key.startsWith('MEMO_FAKE_')) delete env[key];
  child = spawn(process.execPath, [path.join(project, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';child.stderr.on('data', chunk => { logs += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 10000);
    child.stdout.on('data', chunk => { logs += chunk;if (logs.includes('Memo server running')) { clearTimeout(timer);resolve(); } });
    child.once('exit', code => { clearTimeout(timer);reject(new Error('Startup ' + code + ': ' + logs)); });
  });
  async function turn(body) {
    const metrics = { stage: body.stage, firstQuestionMs: null, questionLengths: [], result: null };
    const started = Date.now();console.log(JSON.stringify({ startedRealTurn: body.stage, agent }));
    const response = await fetch(base + '/api/habit/wish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(660000) });
    assert.equal(response.status, 200);assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();let buffer = '';
    while (true) {
      const { value, done } = await reader.read();if (done) break;
      buffer += decoder.decode(value, { stream: true });let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], text = /^data: (.+)$/m.exec(frame)?.[1];
        if (!text) continue;const payload = JSON.parse(text);
        if (event === 'error') throw new Error(payload.error + '\nServer: ' + logs.slice(-3000));
        if (event === 'question') {
          if (metrics.firstQuestionMs === null) { metrics.firstQuestionMs = Date.now() - started;console.log(JSON.stringify({ firstRealQuestionMs: metrics.firstQuestionMs, stage: body.stage })); }
          if (payload.text.length !== metrics.questionLengths.at(-1)) metrics.questionLengths.push(payload.text.length);
        }
        if (event === 'result') metrics.result = payload;
      }
    }
    assert.ok(metrics.result, 'No complete result');
    metrics.elapsedMs = Date.now() - started;report.turns.push(metrics);
    if (body.stage !== 'generate') {
      assert.equal(metrics.result.options.length, 3);
      assert.ok(metrics.questionLengths.length > 1, 'The real question must grow before completion');
      console.log(JSON.stringify({ finishedRealTurn: body.stage, elapsedMs: metrics.elapsedMs, streamedLengths: metrics.questionLengths, ...metrics.result }));
    } else console.log(JSON.stringify({ finishedRealTurn: body.stage, elapsedMs: metrics.elapsedMs, pool: metrics.result.pool }));
    return metrics.result;
  }
  const purpose = await turn({ stage: 'purpose', wish: report.fictionalWish });
  const chosenPurpose = purpose.options[0];
  await turn({ stage: 'effort', wish: report.fictionalWish, purpose: chosenPurpose });
  const input = { stage: 'generate', wish: report.fictionalWish, purpose: chosenPurpose, effort: '每天5分钟，用手边纸笔轻松尝试，不买设备', requestId: randomUUID() };
  const { pool } = await turn(input);
  assert.equal(pool.habits.length, 30);assert.deepEqual(pool.wishContext, { wish: input.wish, purpose: input.purpose, effort: input.effort });
  const pools = await (await fetch(base + '/api/habit/pools')).json();assert.equal(pools.pools.length, 1);
  const repeated = await (await fetch(base + '/api/habit/wish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json();
  assert.equal(repeated.pool.id, pool.id);
  const draw = await fetch(base + '/api/habit/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poolId: pool.id }) });assert.equal(draw.status, 200);
  report.ok = true;
  const filename = path.join(os.tmpdir(), 'memo-wish-real-report-' + Date.now() + '.json');
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ realAssistantEndToEnd: true, agent, cards: pool.habits.length, idempotentRetry: true, draw: true, reportFile: filename }));
}
main().catch(error => { console.error(error.stack);process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM');await once(child, 'close'); }
  fs.rmSync(root, { recursive: true, force: true });
});
