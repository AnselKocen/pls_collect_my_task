const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'service-control.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function fixture(t, port) {
  if (port === undefined) port = await freePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-control-test-'));
  const control = path.join(directory, 'control');
  fs.mkdirSync(control);
  const env = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), MEMO_NO_OPEN: '1',
    MEMO_CONTROL_DIR: control, MEMO_DATA_DIR: path.join(directory, 'data'),
    MEMO_CONFIG_DIR: path.join(directory, 'config'), MEMO_CONTROL_TIMEOUT_MS: '6000'
  };
  const owned = new Map();
  const statePath = path.join(control, '.server-state.json'), pidPath = path.join(control, '.server.pid');
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  async function run(action, options = {}) {
    const command = options.shell ? '/bin/bash' : process.execPath;
    const args = options.shell ? [path.join(root, action + '.sh')] : [helper, action];
    const child = spawn(command, args, { env: { ...env, ...options.env }, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [code, signal] = await once(child, 'close');
    clearTimeout(timer);
    if (action === 'start' && code === 0 && fs.existsSync(statePath)) { const saved = state(); owned.set(saved.pid, saved.instanceId); }
    return { code, signal, stdout, stderr };
  }
  t.after(async () => {
    // Only PIDs returned by a successful start of this fixture belong to cleanup.
    for (const [pid, instanceId] of owned) {
      try {
        const info = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
        if (info.pid === pid && info.instanceId === instanceId) process.kill(pid, 'SIGTERM');
      } catch {}
    }
    for (let i = 0; i < 30; i++) {
      let any = false;
      for (const pid of owned.keys()) { try { process.kill(pid, 0); any = true; } catch {} }
      if (!any) break;
      await pause(20);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, control, env, port, run, state, statePath, pidPath, base: `http://127.0.0.1:${port}` };
}

function passed(result) { assert.equal(result.code, 0, result.stdout + result.stderr); }
function rejected(result, pattern = /占用|不匹配/) { assert.equal(result.code, 1, result.stdout + result.stderr); assert.match(result.stderr, pattern); }

test('start verifies health, reuses only its matching instance, and stop/restart preserves data', async t => {
  const f = await fixture(t);
  passed(await f.run('start'));
  const original = f.state(), healthResponse = await fetch(f.base + '/api/health'), health = await healthResponse.json();
  assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
  assert.equal(health.application, 'memo-journal'); assert.equal(health.ready, true);
  assert.equal(health.pid, original.pid); assert.equal(health.instanceId, original.instanceId); assert.equal(health.dataId, original.dataId);
  assert.equal(Number(fs.readFileSync(f.pidPath)), original.pid);
  const reuse = await f.run('start'); passed(reuse); assert.match(reuse.stdout, /服务已在运行/); assert.deepEqual(f.state(), original);
  const post = await fetch(f.base + '/api/memos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '重启保留的虚构便签', tags: [] }) });
  assert.equal(post.status, 200);
  passed(await f.run('stop')); assert.ok(!fs.existsSync(f.pidPath)); assert.ok(!fs.existsSync(f.statePath));
  passed(await f.run('start')); assert.notEqual(f.state().instanceId, original.instanceId);
  assert.equal((await (await fetch(f.base + '/api/memos')).json()).length, 6);
  passed(await f.run('stop'));
});

test('a custom data directory remains the default CLI config directory', async t => {
  const f = await fixture(t), env = { MEMO_CONFIG_DIR: undefined };
  passed(await f.run('start', { env })); assert.equal(f.state().configDir, f.env.MEMO_DATA_DIR);
  passed(await f.run('stop', { env }));
});

test('verified stop releases an in-flight simulated AI child as well as the server', async t => {
  const f = await fixture(t), cli = path.join(f.directory, 'hang.cjs'), launcher = path.join(f.directory, 'claude-fixture'), marker = path.join(f.directory, 'ai.pid');
  fs.writeFileSync(cli, "const fs=require('node:fs');if(process.argv.includes('--version')){console.log('CC fixture');process.exit(0)}fs.writeFileSync(process.env.MEMO_CONTROL_AI_PID,String(process.pid));process.stdin.resume();process.stdin.on('end',()=>{setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)});");
  fs.writeFileSync(launcher, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + quote(process.execPath) + ' ' + quote(cli) + ' "$@"\n', { mode: 0o755 });
  passed(await f.run('start', { env: { CLAUDE_CLI: launcher, MEMO_CONTROL_AI_PID: marker } }));
  const pending = fetch(f.base + '/api/cc/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'graph' }), signal: AbortSignal.timeout(10000) }).then(r => r.text()).catch(e => e.message);
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await pause(10);
  assert.ok(fs.existsSync(marker)); const aiPid = Number(fs.readFileSync(marker));
  passed(await f.run('stop')); await pending;
  let released = false;
  for (let i = 0; i < 50; i++) { try { process.kill(aiPid, 0); } catch (e) { if (e.code === 'ESRCH') { released = true; break; } } await pause(20); }
  assert.equal(released, true, 'AI child was not released');
});

test('an unrelated live PID is ignored on start and never signaled by stop', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.pidPath, String(process.pid));
  passed(await f.run('stop')); process.kill(process.pid, 0); assert.ok(!fs.existsSync(f.pidPath));
  fs.writeFileSync(f.pidPath, String(process.pid));
  passed(await f.run('start')); assert.notEqual(f.state().pid, process.pid); process.kill(process.pid, 0);
  passed(await f.run('stop')); process.kill(process.pid, 0);
});

test('arbitrary HTTP 200 is not Memo and is never reused or stopped', async t => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, server.address().port);
  fs.writeFileSync(f.pidPath, String(process.pid));
  rejected(await f.run('start')); rejected(await f.run('stop'));
  assert.equal((await fetch(f.base)).status, 200); process.kill(process.pid, 0);
  assert.ok(!fs.existsSync(f.env.MEMO_DATA_DIR));
});

test('another Memo data directory and unrecorded instances cannot be adopted or stopped', async t => {
  const a = await fixture(t); passed(await a.run('start'));
  const b = await fixture(t, a.port);
  rejected(await b.run('start')); rejected(await b.run('stop'));
  assert.equal((await (await fetch(a.base + '/api/health')).json()).pid, a.state().pid);
  assert.ok(!fs.existsSync(b.env.MEMO_DATA_DIR));
  const unrecorded = await fixture(t, a.port);
  rejected(await unrecorded.run('start', { env: { MEMO_DATA_DIR: a.env.MEMO_DATA_DIR } }));
  rejected(await unrecorded.run('stop', { env: { MEMO_DATA_DIR: a.env.MEMO_DATA_DIR } }));
  passed(await a.run('stop'));
});

test('PID and instance-ID mismatches prevent stop even for valid Memo health', async t => {
  const f = await fixture(t); passed(await f.run('start')); const valid = f.state();
  for (const change of [{ instanceId: 'different-instance' }, { pid: process.pid }]) {
    fs.writeFileSync(f.statePath, JSON.stringify({ ...valid, ...change }));
    rejected(await f.run('start')); rejected(await f.run('stop')); process.kill(process.pid, 0);
    assert.equal((await (await fetch(f.base + '/api/health')).json()).pid, valid.pid);
  }
  fs.writeFileSync(f.statePath, JSON.stringify(valid)); passed(await f.run('stop'));
});

test('legacy PID files require matching real health before reuse and safe stop', async t => {
  const f = await fixture(t); passed(await f.run('start')); const original = f.state(); fs.rmSync(f.statePath);
  const reused = await f.run('start'); passed(reused); assert.match(reused.stdout, /服务已在运行/); assert.equal(f.state().pid, original.pid);
  fs.rmSync(f.statePath); passed(await f.run('stop')); assert.ok(!fs.existsSync(f.pidPath));
});

test('concurrent starts create one server and recover a dead lock owner', async t => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await fixture(t), lock = path.join(f.control, '.server-control.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-test-owner' }));
    const runs = await Promise.all([f.run('start'), f.run('start'), f.run('start')]); runs.forEach(passed);
    assert.equal(runs.filter(r => r.stdout.includes('服务已启动')).length, 1);
    const pids = runs.map(r => Number(r.stdout.match(/PID (\d+)/)[1])); assert.equal(new Set(pids).size, 1); assert.equal(f.state().pid, pids[0]);
    assert.ok(!fs.existsSync(lock)); passed(await f.run('stop'));
  }
});

test('an old lock without an owner is recovered and unknown live locks time out safely', async t => {
  const f = await fixture(t), lock = path.join(f.control, '.server-control.lock');
  fs.mkdirSync(lock); fs.utimesSync(lock, new Date(0), new Date(0));
  passed(await f.run('start')); passed(await f.run('stop'));
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live-unrelated-owner' }));
  rejected(await f.run('start', { env: { MEMO_CONTROL_TIMEOUT_MS: '100' } }), /另一个启动或停止/);
  process.kill(process.pid, 0); fs.rmSync(lock, { recursive: true });
});

test('startup initialization failure cannot be reported as ready', async t => {
  const f = await fixture(t); fs.mkdirSync(f.env.MEMO_DATA_DIR); fs.writeFileSync(path.join(f.env.MEMO_DATA_DIR, 'memos.json'), '{broken');
  const result = await f.run('start'); rejected(result, /启动失败|未.*就绪/); assert.match(result.stderr, /JSON/);
  assert.ok(!fs.existsSync(f.pidPath)); assert.ok(!fs.existsSync(f.statePath));
});

test('matching health that remains unready times out without reporting success', async t => {
  let identity;
  const server = http.createServer((req, res) => { res.statusCode = 503; res.end(JSON.stringify(identity)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, server.address().port);
  const { createHash } = require('node:crypto');
  identity = { application: 'memo-journal', protocol: 1, ready: false, pid: process.pid, instanceId: 'unready-fixture', dataId: createHash('sha256').update(f.env.MEMO_DATA_DIR).digest('hex') };
  fs.writeFileSync(f.statePath, JSON.stringify({ ...identity, port: f.port })); fs.writeFileSync(f.pidPath, String(process.pid));
  const result = await f.run('start', { env: { MEMO_CONTROL_TIMEOUT_MS: '200' } });
  rejected(result, /未.*就绪/); assert.doesNotMatch(result.stdout, /服务已启动|服务已在运行/); process.kill(process.pid, 0);
});

test('a recorded instance on another port is not orphaned by a PORT override', async t => {
  const f = await fixture(t); passed(await f.run('start')); const original = f.state();
  const differentPort = await freePort(); rejected(await f.run('start', { env: { PORT: String(differentPort) } }), /仍在管理/);
  assert.deepEqual(f.state(), original); passed(await f.run('stop'));
});

test('Mac shell wrappers use custom PORT/control directories and open only verified services', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), bin = path.join(f.directory, 'bin'); fs.mkdirSync(bin);
  const openLog = path.join(f.directory, 'open.log');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nprintf "%s" "$1" >> "$MEMO_TEST_OPEN_LOG"\n', { mode: 0o755 });
  const env = { PATH: bin + ':/usr/bin:/bin', MEMO_NO_OPEN: '0', MEMO_TEST_OPEN_LOG: openLog };
  passed(await f.run('start', { shell: true, env })); assert.equal(fs.readFileSync(openLog, 'utf8'), 'http://localhost:' + f.port);
  passed(await f.run('stop', { shell: true, env }));
  fs.rmSync(openLog);
  const foreign = http.createServer((req, res) => res.end('other app')); foreign.listen(f.port, '127.0.0.1'); await once(foreign, 'listening');
  try { rejected(await f.run('start', { shell: true, env })); assert.ok(!fs.existsSync(openLog)); }
  finally { await new Promise(resolve => foreign.close(resolve)); }
});

test('Windows wrappers delegate identity management and preserve externally supplied PORT', () => {
  const start = fs.readFileSync(path.join(root, 'start.bat'), 'utf8'), stop = fs.readFileSync(path.join(root, 'stop.bat'), 'utf8');
  assert.match(start, /if not defined PORT set "PORT=3013"/);
  assert.match(start, /node service-control\.js start\r?\nif errorlevel 1 exit \/b 1/);
  assert.match(stop, /node service-control\.js stop/);
  assert.doesNotMatch(start + stop, /taskkill|tasklist|netstat|set \/p PID/i);
});
