const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SELECTABLE_AGENTS, getSelectableAgent, resolveCli, configDirectory } = require('./index');
const { createCommandRunner, readCodexConfiguration, testConnection } = require('./connection-test');

const details = Object.freeze({
  missing:'本机未检测到 CLI，请先安装对应助手。',
  logged_out:'本机未检测到登录状态，请先在对应 CLI 中登录或完成认证配置。',
  detected:'已检测到登录状态，实际连接可手动测试。',
  unknown:'已检测到 CLI，登录状态尚未确认，可手动测试连接。'
});

function createAvailability({ configDir, env = process.env, timeoutMs = 4000, testTimeoutMs = 30000 } = {}) {
  configDir = configDir || configDirectory(env);
  const runner = createCommandRunner(), helpById = new Map();
  const childEnv = { ...env, CI:'1', DISABLE_AUTOUPDATER:'1', DISABLE_NON_ESSENTIAL_MODEL_CALLS:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1' };
  let disposed = false, checking = false, checkedAt = null, refreshing = null, testing = null;
  let agents = SELECTABLE_AGENTS.map(id => ({id,name:getSelectableAgent(id).name,state:'unknown',canTest:false,detail:'正在检查本机 CLI…',test:{state:'idle'}}));
  const snapshot = () => JSON.parse(JSON.stringify({ checking, checkedAt, agents }));
  function error(message, code) { return Object.assign(new Error(message), { code }); }
  async function inspect(id, cwd) {
    const command = resolveCli(id, {env,configDir});
    if (!command) return 'missing';
    const version = await runner.run(command, ['--version'], {env:childEnv,cwd,timeoutMs});
    if (version.code !== 0 || version.timedOut || version.failed || !version.stdout.trim()) return 'unknown';
    const help = await runner.run(command, ['--help'], {env:childEnv,cwd,timeoutMs});
    if (help.code === 0) helpById.set(id, help.stdout);
    else { helpById.delete(id);return 'unknown'; }
    if (id === 'codebuddy') return 'unknown';
    const group = id === 'codex' ? 'login' : 'auth';
    // Never pass an unknown positional command to a CLI: old versions can
    // interpret it as a model prompt instead of a status subcommand.
    if (!new RegExp('^\\s*' + group + '(?:\\s|\\[|$)', 'm').test(help.stdout)) return 'unknown';
    const commandHelp = await runner.run(command, [group,'--help'], {env:childEnv,cwd,timeoutMs});
    if (commandHelp.code !== 0 || !/^\s*status(?:\s|\[|$)/m.test(commandHelp.stdout)) return 'unknown';
    const status = await runner.run(command, [group,'status'], {env:childEnv,cwd,timeoutMs});
    if (status.timedOut || status.cancelled || status.overflow || status.failed) return 'unknown';
    if (id === 'cc') {
      let info;try { info = JSON.parse(status.stdout); } catch { return 'unknown'; }
      if (status.code === 0 && info.loggedIn === true) return 'detected';
      if (status.code === 1 && info.loggedIn === false && (!info.authMethod || info.authMethod === 'none')) return 'logged_out';
    } else {
      const output = status.stdout + '\n' + status.stderr;
      if (status.code === 0 && /^\s*Logged in\b/im.test(output)) return 'detected';
      if (status.code === 1 && /^\s*Not logged in\b/im.test(output)) {
        if (!/^\s*app-server(?:\s|\[|$)/m.test(help.stdout)) return 'unknown';
        const {effective,requiresOpenaiAuth} = await readCodexConfiguration(command,{runner,env:childEnv,cwd,timeoutMs,auth:true});
        // A custom provider or environment API key may work with no OpenAI
        // login cache. Only the known default OpenAI case is clearly logged out.
        if (requiresOpenaiAuth === true && effective && (!effective.model_provider || effective.model_provider === 'openai') && !env.OPENAI_API_KEY) return 'logged_out';
      }
    }
    return 'unknown';
  }
  function refresh() {
    if (refreshing) return refreshing;
    if (disposed) return Promise.reject(error('检测已停止。', 'AI_CHECK_STOPPED'));
    if (testing) return Promise.reject(error('连接测试进行中，请稍后重新检测。', 'AI_BUSY'));
    checking = true;
    refreshing = (async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cli-check-'));
      try {
        const states = await Promise.all(SELECTABLE_AGENTS.map(async id => {
          try { return await inspect(id, cwd); } catch { return 'unknown'; }
        }));
        if (!disposed) {
          agents = agents.map((agent, index) => ({ ...agent,state:states[index],canTest:!['missing','logged_out'].includes(states[index]),detail:details[states[index]],test:states[index] === agent.state && !['missing','logged_out'].includes(states[index]) ? agent.test : {state:'idle'} }));
          checkedAt = new Date().toISOString();
        }
      } finally { fs.rmSync(cwd, {recursive:true,force:true});checking = false;refreshing = null; }
      return snapshot();
    })();
    return refreshing;
  }
  async function test(id) {
    getSelectableAgent(id);
    if (disposed) throw error('检测已停止。', 'AI_CHECK_STOPPED');
    if (checking || !checkedAt) throw error('正在检查本机助手，请稍后再试。', 'AI_CHECKING');
    if (testing) throw error('已有连接测试正在进行，请稍后再试。', 'AI_BUSY');
    const agent = agents.find(row => row.id === id);
    const command = resolveCli(id, {env,configDir});
    if (!agent.canTest || !command) throw error('请先安装并登录对应 CLI，再测试连接。', 'AI_TEST_UNAVAILABLE');
    testing = id;agent.test = {state:'running'};
    try {
      const outcome = await testConnection(id, command, {runner,env:childEnv,help:helpById.get(id),timeoutMs:Math.min(testTimeoutMs,30000)});
      agent.test = {state:outcome.success ? 'success' : 'failed',checkedAt:new Date().toISOString(),message:outcome.message};
    } catch { agent.test = {state:'failed',checkedAt:new Date().toISOString(),message:'暂时未能连接，请确认对应 CLI 可以正常使用后重试。'}; }
    finally { testing = null; }
    return snapshot();
  }
  return {refresh,snapshot,test,dispose() { disposed = true;runner.dispose(); }};
}

module.exports = { createAvailability };
