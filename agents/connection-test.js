const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { CODEX_HTTP_PROVIDER, CODEX_HTTP_CONFIG } = require('./stream-protocol');

// This is the only model input used by a connection test. Journal data never
// enters this module, and startup checks never call testConnection.
const TEST_PROMPT = 'Connection test only. Reply with exactly OK. Do not use tools or read any files.';
const TEST_SYSTEM = 'You are testing a model connection. Reply with exactly OK. Do not call any tool, read files, or perform any other task.';

function createCommandRunner() {
  const active = new Set();
  let disposed = false;
  function terminate(child, signal = 'SIGTERM') {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio:'ignore', windowsHide:true, timeout:2000 });
      else process.kill(-child.pid, signal);
    } catch { try { child.kill(signal); } catch {} }
  }
  function run(command, args, { env, cwd, timeoutMs = 4000, input = '', onLine } = {}) {
    if (disposed) return Promise.resolve({ code:null, cancelled:true, stdout:'', stderr:'' });
    return new Promise(resolve => {
      const options = { env, cwd, stdio:['pipe','pipe','pipe'], windowsHide:true, detached:process.platform !== 'win32' };
      const quote = value => '"' + String(value).replace(/"/g, '\\"') + '"';
      let child;
      try {
        child = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
          ? spawn(quote(command), args.map(quote), { ...options, shell:true })
          : spawn(command, args, options);
      } catch { resolve({ code:null, failed:true, stdout:'', stderr:'' });return; }
      let stdout = '', stderr = '', buffer = '', size = 0, reason, hardKill, settled = false;
      function cancel(nextReason) {
        if (reason) return;
        reason = nextReason;
        terminate(child);
        hardKill = setTimeout(() => terminate(child, 'SIGKILL'), 200);
        hardKill.unref();
      }
      const entry = { child, cancel };
      active.add(entry);
      const timer = setTimeout(() => cancel('timedOut'), timeoutMs);
      function finish(code) {
        if (settled) return;
        settled = true;clearTimeout(timer);
        // The direct child may exit before a descendant which ignores SIGTERM.
        // Keep the group SIGKILL scheduled on cancelled/timeout paths.
        if (!reason) clearTimeout(hardKill);
        active.delete(entry);
        resolve({ code, stdout, stderr, ...(reason ? { [reason]:true } : {}) });
      }
      const send = row => { if (!child.stdin.destroyed && !reason) child.stdin.write(JSON.stringify(row) + '\n'); };
      function collect(data, errorStream) {
        size += Buffer.byteLength(data);
        if (size > 128 * 1024) return cancel('overflow');
        if (errorStream) stderr += data;
        else {
          stdout += data;
          if (!onLine) return;
          buffer += data;
          let at;
          while ((at = buffer.indexOf('\n')) >= 0 && !reason) {
            const line = buffer.slice(0, at);buffer = buffer.slice(at + 1);
            try { onLine(line, { send, end:() => child.stdin.end(), stop:() => cancel('stopped') }); }
            catch { cancel('protocolError'); }
          }
        }
      }
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => collect(data, false));
      child.stderr.on('data', data => collect(data, true));
      child.stdin.on('error', () => {});
      child.on('error', () => { reason = 'failed'; });
      child.on('close', finish);
      if (onLine) onLine(null, { send, end:() => child.stdin.end(), stop:() => cancel('stopped') });
      else child.stdin.end(input);
    });
  }
  return {
    run,
    dispose() { disposed = true;for (const entry of active) entry.cancel('cancelled'); }
  };
}

function connectionMessage(result) {
  if (result.timedOut) return '连接测试超时，请检查网络后重试。';
  if (result.cancelled) return '连接测试已停止。';
  const text = result.stdout + '\n' + result.stderr;
  if (/unauthorized|not logged|authentication|sign.?in|log.?in|登录|401/i.test(text)) return '连接未通过，请在对应 CLI 中确认登录或认证配置后重试。';
  if (/quota|rate.?limit|insufficient|billing|额度|余额|429/i.test(text)) return '连接未通过，请在对应 CLI 中检查额度或使用限制。';
  if (/unknown (?:option|argument)|unrecognized|unexpected argument|invalid (?:option|value)/i.test(text)) return '当前 CLI 版本不支持安全连接测试，请升级后重试。';
  return '暂时未能连接，请确认对应 CLI 可以正常使用后重试。';
}

// Disable command/file/network tools and all custom MCP servers for this one
// ephemeral thread. Global user configuration is never written.
const CODEX_TEST_CONFIG = Object.freeze({
  'features.shell_tool':false, 'features.shell_snapshot':false,
  'features.apply_patch_freeform':false, 'features.view_image':false,
  'features.js_repl':false, 'features.code_mode':false,
  'features.computer_use':false, 'features.browser_use':false,
  'features.apps':false, 'features.plugins':false,
  'features.multi_agent':false, 'agents.enabled':false,
  'features.hooks':false, 'features.codex_hooks':false,
  'features.memories':false, 'features.request_permissions_tool':false,
  'features.goals':false,
  'features.skill_mcp_dependency_install':false,
  'skills.include_instructions':false, 'skills.bundled.enabled':false,
  project_doc_max_bytes:0, web_search:'disabled',
  approval_policy:'never', sandbox_mode:'read-only'
});

async function readCodexConfiguration(command, { runner, env, cwd, timeoutMs, auth = false }) {
  let effective, requirements, requirementsRead = false, accountRead = !auth, requiresOpenaiAuth;
  const baseArgs = ['app-server','--listen','stdio://', ...Object.entries(CODEX_TEST_CONFIG).flatMap(([key,value]) => ['--config', `${key}=${JSON.stringify(value)}`])];
  const preflight = await runner.run(command, baseArgs, {env,cwd,timeoutMs:Math.min(5000,timeoutMs),onLine(line, io) {
    if (line === null) { io.send({id:1,method:'initialize',params:{clientInfo:{name:'memo_connection_check',version:'1.0.0'},capabilities:{}}});return; }
    let row;try { row = JSON.parse(line); } catch { return; }
    if (row.id === 1) {
      if (row.error) { io.end();return; }
      io.send({method:'initialized'});
      io.send({id:2,method:'config/read',params:{includeLayers:false,cwd}});
      io.send({id:3,method:'configRequirements/read',params:{}});
      if (auth) io.send({id:4,method:'account/read',params:{refreshToken:false}});
    } else if (row.id === 2) effective = row.result?.config;
    else if (row.id === 3) { requirementsRead = true;requirements = row.error ? undefined : row.result?.requirements || null; }
    else if (row.id === 4) { accountRead = true;requiresOpenaiAuth = row.result?.requiresOpenaiAuth; }
    if (effective && requirementsRead && accountRead) io.end();
    else if (row.id === 2 && row.error) io.end();
  }});
  return {effective,requirements,requiresOpenaiAuth,result:preflight};
}

async function testCodex(command, { runner, env, cwd, timeoutMs }) {
  const started = Date.now();
  const {effective,requirements,result:preflight} = await readCodexConfiguration(command,{runner,env,cwd,timeoutMs});
  if (!effective || preflight.cancelled || preflight.failed) return {success:false,result:preflight};
  const noCustomEndpoint = !env.OPENAI_BASE_URL && !env.OPENAI_API_BASE && !env.CODEX_CHATGPT_BASE_URL;
  const useHTTP = requirements !== undefined && noCustomEndpoint && (!effective.model_provider || effective.model_provider === 'openai') && !effective.openai_base_url && !requirements?.modelProvider && !requirements?.modelProviders;
  let stage = 'initialize', answer = '', complete = false, failed = false;
  const config = { ...CODEX_TEST_CONFIG };
  for (const name of Object.keys(effective.mcp_servers || {})) config[`mcp_servers.${JSON.stringify(name)}.enabled`] = false;
  const args = ['app-server','--listen','stdio://', ...Object.entries(config).flatMap(([key,value]) => ['--config', `${key}=${JSON.stringify(value)}`]),
    ...(useHTTP ? [`model_provider=${JSON.stringify(CODEX_HTTP_PROVIDER)}`,...CODEX_HTTP_CONFIG].flatMap(value => ['--config',value]) : [])];
  const result = await runner.run(command, args, { env, cwd, timeoutMs:Math.max(1,timeoutMs-(Date.now()-started)), onLine(line, io) {
    if (line === null) { io.send({ id:1, method:'initialize', params:{clientInfo:{name:'memo_connection_test',title:'记忆手帐连接测试',version:'1.0.0'},capabilities:{}} });return; }
    let row;try { row = JSON.parse(line); } catch { return; }
    if (row.error) { failed = true;io.end();return; }
    if (row.id === 1 && stage === 'initialize') {
      stage = 'thread';io.send({ method:'initialized' });
      io.send({ id:3, method:'thread/start', params:{cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',baseInstructions:TEST_SYSTEM,developerInstructions:TEST_SYSTEM,config} });
    } else if (row.id === 3 && stage === 'thread') {
      if (typeof row.result?.thread?.id !== 'string') { failed = true;io.end();return; }
      stage = 'turn';
      io.send({ id:4, method:'turn/start', params:{threadId:row.result.thread.id,input:[{type:'text',text:TEST_PROMPT,text_elements:[]}],summary:'none'} });
    } else if (row.method === 'item/completed' && row.params?.item?.type === 'agentMessage') {
      answer = row.params.item.text || answer;
    } else if (row.method === 'item/agentMessage/delta') {
      answer += row.params?.delta || '';
    } else if (row.method === 'turn/completed') {
      complete = row.params?.turn?.status === 'completed';failed = !complete;io.end();
    } else if (row.method === 'error' && !row.params?.willRetry) {
      failed = true;io.end();
    } else if (row.id !== undefined && row.method) {
      // No interactive approvals, dynamic tools, or elicitation are provided.
      failed = true;io.send({id:row.id,error:{code:-32601,message:'Tools are disabled for connection tests.'}});io.end();
    }
  }});
  return { success:complete && !failed && result.code === 0 && !result.timedOut && !result.cancelled && Boolean(answer.trim()), result };
}

async function testConnection(id, command, { runner, env, help, timeoutMs = 30000 }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-connection-'));
  // Authentication and network configuration remain available, but an explicit
  // development plugin path must not bypass the empty settings/MCP sources.
  env = {...env};delete env.CODEBUDDY_PLUGIN_DIRS;
  try {
    let outcome;
    if (id === 'codex') {
      if (!/^\s*app-server(?:\s|\[|$)/m.test(help || '')) return {success:false,message:'当前 CLI 版本不支持安全连接测试，请升级后重试。'};
      outcome = await testCodex(command, { runner, env, cwd, timeoutMs });
    }
    else {
      const required = ['--tools','--strict-mcp-config','--setting-sources','--settings','--no-session-persistence','--system-prompt','--max-turns'];
      // Old clients must not silently fall back to an unrestricted agent run.
      if (required.some(flag => !help?.includes(flag))) return { success:false, message:'当前 CLI 版本不支持安全连接测试，请升级后重试。' };
      const args = ['-p','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
        '--setting-sources','','--settings','{"hooks":{},"disableAllHooks":true,"enabledPlugins":{}}',
        '--no-session-persistence','--system-prompt',TEST_SYSTEM,'--max-turns','1'];
      if (id === 'cc' && help.includes('--safe-mode')) args.push('--safe-mode');
      const result = await runner.run(command, args, { env, cwd, timeoutMs, input:TEST_PROMPT });
      let row;try { row = JSON.parse(result.stdout.trim()); } catch {}
      outcome = { success:result.code === 0 && !result.timedOut && !result.cancelled && !row?.is_error && typeof row?.result === 'string' && Boolean(row.result.trim()), result };
    }
    return { success:outcome.success, message:outcome.success ? '连接成功，可以使用 AI 功能。' : connectionMessage(outcome.result) };
  } finally { fs.rmSync(cwd, { recursive:true, force:true }); }
}

module.exports = { createCommandRunner, readCodexConfiguration, testConnection, TEST_PROMPT };
