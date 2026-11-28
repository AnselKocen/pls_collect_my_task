require('./storage/runtime')();
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function context(env = process.env) {
  const port = Number(env.PORT || 3013), timeout = Number(env.MEMO_CONTROL_TIMEOUT_MS || 60000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 需要是 1–65535 的端口号');
  if (!Number.isFinite(timeout) || timeout < 100) throw new Error('启动等待时间无效');
  const directory = path.resolve(env.MEMO_CONTROL_DIR || __dirname);
  const dataDir = path.resolve(env.MEMO_DATA_DIR || path.join(__dirname, 'data'));
  return {
    env, port, directory, dataDir, timeout,
    configDir: path.resolve(env.MEMO_CONFIG_DIR || env.MEMO_DATA_DIR || __dirname),
    dataId: createHash('sha256').update(dataDir).digest('hex'),
    pidFile: path.join(directory, '.server.pid'), stateFile: path.join(directory, '.server-state.json'),
    lockDir: path.join(directory, '.server-control.lock'), logFile: path.join(directory, '.server.log'),
    url: `http://localhost:${port}`
  };
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function readPid(filename) {
  try {
    const value = fs.readFileSync(filename, 'utf8').trim();
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function atomicWrite(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, value, { mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function persist(ctx, state) {
  atomicWrite(ctx.stateFile, JSON.stringify(state, null, 2));
  atomicWrite(ctx.pidFile, String(state.pid) + '\n');
}
function clearRecords(ctx, expected) {
  const state = readJson(ctx.stateFile);
  if (!expected || (state?.pid === expected.pid && state.instanceId === expected.instanceId)) fs.rmSync(ctx.stateFile, { force: true });
  if (!expected || readPid(ctx.pidFile) === expected.pid) fs.rmSync(ctx.pidFile, { force: true });
}

async function withLock(ctx, work) {
  fs.mkdirSync(ctx.directory, { recursive: true });
  const owner = { pid: process.pid, token: randomUUID() }, ownerFile = path.join(ctx.lockDir, 'owner.json');
  const deadline = Date.now() + ctx.timeout + 2000;
  const transient = error => ['ENOENT', 'EINVAL', 'ENOTEMPTY'].includes(error.code);
  const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  let heldDirectory;
  async function retire() {
    // Never recursively remove the reusable lock pathname: another starter may
    // already have acquired it while APFS is finishing the old removal.
    const retired = `${ctx.lockDir}.${randomUUID()}.retired`;
    fs.renameSync(ctx.lockDir, retired);
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(retired, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); return; }
      catch (error) { if (!transient(error) || attempt >= 3) throw error; await delay(10); }
    }
  }
  while (true) {
    try {
      fs.mkdirSync(ctx.lockDir);
      fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
      if (readJson(ownerFile)?.token === owner.token) { heldDirectory = fs.statSync(ctx.lockDir); break; }
    }
    catch (error) {
      if (error.code !== 'EEXIST' && !transient(error)) throw error;
      try {
        const previous = readJson(ownerFile), previousStat = fs.statSync(ctx.lockDir), age = Date.now() - previousStat.mtimeMs;
        if ((previous?.pid && !alive(previous.pid)) || (!previous?.pid && age > 5000)) {
          // Serialize stale-lock recovery too: competing starters must not remove
          // a fresh lock acquired just after another starter removed the old one.
          const reclaimFile = path.join(ctx.lockDir, 'reclaim.json');
          let claimed = false, removed = false;
          try {
            fs.writeFileSync(reclaimFile, JSON.stringify(owner), { flag: 'wx' });
            claimed = true;
            const current = readJson(ownerFile), currentStat = fs.statSync(ctx.lockDir);
            const sameOwner = current?.pid === previous?.pid && current?.token === previous?.token;
            if (sameDirectory(currentStat, previousStat) && sameOwner &&
                ((current?.pid && !alive(current.pid)) || (!current?.pid && age > 5000))) {
              await retire(); removed = true;
            }
          } catch (reclaimError) {
            if (reclaimError.code !== 'EEXIST' && !transient(reclaimError)) throw reclaimError;
          } finally {
            if (claimed && readJson(reclaimFile)?.token === owner.token) fs.rmSync(reclaimFile, { force: true });
          }
          if (removed) continue;
        }
      } catch (inspection) { if (!transient(inspection)) throw inspection; }
    }
    if (Date.now() >= deadline) throw new Error('另一个启动或停止操作尚未完成，请稍后重试');
    await delay(50);
  }
  try { return await work(); }
  finally {
    if (readJson(ownerFile)?.token === owner.token && sameDirectory(fs.statSync(ctx.lockDir), heldDirectory)) await retire();
  }
}

function health(ctx) {
  return new Promise(resolve => {
    let connected = false, settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port: ctx.port, path: '/api/health', timeout: 1000 }, response => {
      connected = true;
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 16384) { finish({ present: true, info: null }); response.destroy(); }
      });
      response.on('end', () => {
        let info;
        try { info = JSON.parse(text); } catch { info = null; }
        const valid = info?.application === 'memo-journal' && info.protocol === 1 &&
          Number.isSafeInteger(info.pid) && info.pid > 0 && typeof info.dataId === 'string' &&
          (info.instanceId === null || typeof info.instanceId === 'string');
        finish({ present: true, status: response.statusCode, info: valid ? info : null });
      });
      response.on('error', () => finish({ present: true, info: null }));
    });
    request.on('socket', socket => socket.once('connect', () => { connected = true; }));
    request.on('timeout', () => request.destroy(new Error('health timeout')));
    request.on('error', error => finish({ present: connected || error.code !== 'ECONNREFUSED', info: null }));
  });
}

function matches(ctx, observed, state, legacyPid) {
  const info = observed.info;
  if (!info || info.dataId !== ctx.dataId) return false;
  if (state) return state.port === ctx.port && state.pid === info.pid && state.dataId === info.dataId &&
    state.instanceId === info.instanceId && (!state.configDir || state.configDir === ctx.configDir);
  // Old PID files are trusted only when the actual health identity agrees.
  return legacyPid === info.pid;
}
const conflict = ctx => new Error(`端口 ${ctx.port} 已被其他服务或身份不匹配的实例占用；未连接或停止该进程`);

async function waitReady(ctx, state, childState) {
  const deadline = Date.now() + ctx.timeout;
  while (Date.now() < deadline) {
    if (childState?.exited) {
      let tail = '';
      try { tail = fs.readFileSync(ctx.logFile, 'utf8').slice(-3000).trim(); } catch {}
      throw new Error(`本地服务启动失败，请查看 ${ctx.logFile}${tail ? '\n' + tail : ''}`);
    }
    const observed = await health(ctx);
    if (observed.present) {
      if (!matches(ctx, observed, state)) throw conflict(ctx);
      if (observed.status === 200 && observed.info.ready === true) return observed.info;
    }
    await delay(100);
  }
  throw new Error(`本地服务未在等待时间内就绪，请查看 ${ctx.logFile}`);
}

async function start(ctx = context()) {
  return withLock(ctx, async () => {
    const previous = readJson(ctx.stateFile), legacyPid = readPid(ctx.pidFile);
    if (previous && previous.port !== ctx.port && Number.isInteger(previous.port) && previous.port > 0 && previous.port <= 65535) {
      const other = { ...ctx, port: previous.port, dataId: previous.dataId, configDir: previous.configDir };
      if (matches(other, await health(other), previous)) throw new Error(`此控制目录仍在管理端口 ${previous.port} 的实例，请先停止它或使用独立的 MEMO_CONTROL_DIR`);
    }
    const observed = await health(ctx);
    if (observed.present) {
      if (!matches(ctx, observed, previous, legacyPid)) throw conflict(ctx);
      const state = previous || { pid: observed.info.pid, instanceId: observed.info.instanceId, dataId: ctx.dataId, port: ctx.port, configDir: ctx.configDir };
      const info = await waitReady(ctx, state);
      persist(ctx, state);
      return { started: false, pid: info.pid, url: ctx.url, logFile: ctx.logFile };
    }
    // Ignore stale/reused PIDs without ever signaling them.
    clearRecords(ctx);
    const instanceId = randomUUID(), descriptor = fs.openSync(ctx.logFile, 'a');
    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname, detached: true, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
        env: { ...ctx.env, PORT: String(ctx.port), MEMO_ELECTRON: '1', MEMO_DATA_DIR: ctx.dataDir, MEMO_CONFIG_DIR: ctx.configDir, MEMO_INSTANCE_ID: instanceId }
      });
    } finally { fs.closeSync(descriptor); }
    const childState = { exited: false };
    child.on('exit', () => { childState.exited = true; });
    child.on('error', () => { childState.exited = true; });
    child.unref();
    const state = { pid: child.pid, instanceId, dataId: ctx.dataId, port: ctx.port, configDir: ctx.configDir, startedAt: new Date().toISOString() };
    try {
      if (!child.pid) throw new Error('无法创建本地服务进程');
      persist(ctx, state);
      const info = await waitReady(ctx, state, childState);
      return { started: true, pid: info.pid, url: ctx.url, logFile: ctx.logFile };
    } catch (error) {
      if (!childState.exited) child.kill('SIGTERM'); // Only this call's own child.
      clearRecords(ctx, state);
      throw error;
    }
  });
}

async function stop(ctx = context()) {
  return withLock(ctx, async () => {
    const state = readJson(ctx.stateFile), legacyPid = readPid(ctx.pidFile), observed = await health(ctx);
    if (!observed.present) {
      clearRecords(ctx);
      return { stopped: false, note: '未发现可核验的服务，已清理旧记录；未停止其他进程' };
    }
    if (!matches(ctx, observed, state, legacyPid)) throw conflict(ctx);
    const confirmed = await health(ctx);
    if (!matches(ctx, confirmed, state, legacyPid) || confirmed.info.pid !== observed.info.pid || confirmed.info.instanceId !== observed.info.instanceId) throw conflict(ctx);
    const pid = confirmed.info.pid;
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + Math.min(ctx.timeout, 10000);
    while (Date.now() < deadline) {
      const current = await health(ctx);
      if (!current.present || (current.info && !alive(pid) &&
          (current.info.pid !== pid || current.info.instanceId !== confirmed.info.instanceId))) {
        clearRecords(ctx, state || { pid, instanceId: null });
        return { stopped: true, pid };
      }
      await delay(100);
    }
    throw new Error('停止请求已发送，服务仍未退出；保留记录供重试，未强制终止其他进程');
  });
}

module.exports = { context, health, start, stop };
if (require.main === module) (async () => {
  const action = process.argv[2];
  if (action === 'start') {
    const result = await start();
    console.log(`${result.started ? '服务已启动' : '服务已在运行'} (PID ${result.pid})`);
    console.log(`地址: ${result.url}\n日志: ${result.logFile}`);
  } else if (action === 'stop') {
    const result = await stop();
    console.log(result.stopped ? `服务已停止 (PID ${result.pid})` : result.note);
  } else throw new Error('用法: node service-control.js start|stop');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
