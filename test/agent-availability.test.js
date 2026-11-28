const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./agent-fixture');
const { createAvailability } = require('../agents/availability');
const { createCommandRunner, TEST_PROMPT } = require('../agents/connection-test');

const calls = f => fs.existsSync(f.capture) ? fs.readFileSync(f.capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function availability(t, f, extra = {}) {
  const service = createAvailability({configDir:f.dir,env:f.env,...extra});
  t.after(() => service.dispose());return service;
}

test('startup checks are cached, bounded and never start a model turn', async t => {
  const f = fixture(t), service = availability(t, f);
  const first = service.refresh();
  assert.equal(service.snapshot().checking, true);
  assert.equal(service.refresh(), first, 'concurrent refreshes share one scan');
  const state = await first;
  assert.deepEqual(state.agents.map(row => [row.id,row.state,row.canTest]), [['cc','detected',true],['codex','detected',true],['codebuddy','unknown',true]]);
  assert.equal(state.checking, false);assert.ok(state.checkedAt);
  assert.deepEqual(calls(f), [], 'version/help/status are not model requests');
  assert.ok(!JSON.stringify(state).includes(f.dir), 'no local paths or raw CLI output returned');
  state.agents[0].state = 'changed';assert.equal(service.snapshot().agents[0].state, 'detected');
  assert.deepEqual(calls(f), [], 'reading cached status does not invoke a CLI');
});

test('missing and clearly logged-out clients have no connection test; custom Codex stays unconfirmed', async t => {
  const f = fixture(t);
  f.env.MEMO_FAKE_AUTH_LOGGED_OUT = '1';delete f.env.OPENAI_API_KEY;
  f.env.CODEBUDDY_CLI = path.join(f.dir,'missing-client');
  const service = availability(t,f), state = await service.refresh();
  assert.deepEqual(state.agents.map(row => [row.state,row.canTest]), [['logged_out',false],['logged_out',false],['missing',false]]);
  await assert.rejects(service.test('cc'), {code:'AI_TEST_UNAVAILABLE'});
  await assert.rejects(service.test('codex'), {code:'AI_TEST_UNAVAILABLE'});
  await assert.rejects(service.test('codebuddy'), {code:'AI_TEST_UNAVAILABLE'});
  assert.deepEqual(calls(f), []);
  const custom = availability(t,{...f,env:{...f.env,MEMO_FAKE_CODEX_AUTH_OPTIONAL:'1',MEMO_FAKE_CODEX_CONFIG:JSON.stringify({model_provider:'private'})}});
  const codex = (await custom.refresh()).agents.find(row => row.id === 'codex');
  assert.equal(codex.state,'unknown');assert.equal(codex.canTest,true);
  assert.deepEqual(calls(f), []);
});

test('manual tests use only fixed input, isolated temporary directories and disabled tools', async t => {
  const f = fixture(t), service = availability(t,f);
  await service.refresh();
  for (const id of ['cc','codex','codebuddy']) {
    const state = await service.test(id), row = state.agents.find(row => row.id === id);
    assert.equal(row.test.state,'success',JSON.stringify(row));
    assert.ok(row.test.checkedAt);assert.equal(row.state,id === 'codebuddy' ? 'unknown' : 'detected');
  }
  const records = calls(f);assert.equal(records.length,3);
  for (const record of records) {
    assert.equal(record.task,'connection-test');assert.equal(record.input.prompt,TEST_PROMPT);
    assert.ok(path.basename(record.cwd).startsWith('memo-connection-'));
    assert.equal(fs.existsSync(record.cwd),false,'temporary test directory is removed');
    if (record.agent === 'codex') {
      assert.equal(record.threadConfig.ephemeral,true);
      assert.equal(record.threadConfig.sandbox,'read-only');
      assert.equal(record.threadConfig.approvalPolicy,'never');
      assert.equal(record.threadConfig.config['features.shell_tool'],false);
      assert.equal(record.threadConfig.config['features.hooks'],false);
      assert.equal(record.threadConfig.config.project_doc_max_bytes,0);
      assert.equal(record.modelProvider,'memo_journal_openai_http','use same default HTTP/SSE transport as journal tasks');
    } else {
      assert.equal(record.argv[record.argv.indexOf('--tools')+1],'');
      assert.equal(record.argv[record.argv.indexOf('--setting-sources')+1],'');
      assert.ok(record.argv.includes('--strict-mcp-config'));
      assert.ok(record.argv.includes('--no-session-persistence'));
      assert.equal(JSON.parse(record.argv[record.argv.indexOf('--settings')+1]).disableAllHooks,true);
    }
  }
});

test('Codex tests disable named MCP servers and preserve custom/managed provider selection', async t => {
  for (const variant of ['custom','managed']) {
    const f = fixture(t);
    f.env.MEMO_FAKE_CODEX_CONFIG = JSON.stringify({model_provider:variant === 'custom' ? 'private' : 'openai',mcp_servers:{'sensitive.server':{command:'never-start-this'}}});
    if (variant === 'managed') f.env.MEMO_FAKE_CODEX_HTTP_REJECT = '1';
    const service = availability(t,f);await service.refresh();await service.test('codex');
    const record = calls(f)[0];assert.equal(record.modelProvider,variant === 'custom' ? 'private' : 'openai');
    assert.equal(record.threadConfig.config['mcp_servers."sensitive.server".enabled'],false);
    assert.ok(record.argv.includes('mcp_servers."sensitive.server".enabled=false'));
    assert.deepEqual(Object.keys(record.input),['prompt']);
  }
});

test('old auth command support stays unknown and cannot fall back to unrestricted generation', async t => {
  const f = fixture(t), original = f.env.CLAUDE_CLI;
  const legacy = path.join(f.dir,'legacy');
  const quote = value => "'" + value.replace(/'/g,"'\\''") + "'";
  fs.writeFileSync(legacy, `#!/bin/sh\ncase "$1" in\n--version) echo 'legacy CLI';;\n--help) echo 'Usage: legacy [prompt]';;\n*) echo 'unexpected positional invocation' >> ${quote(f.capture)}; exit 1;;\nesac\n`, {mode:0o755});
  f.env.CLAUDE_CLI = legacy;
  const service = availability(t,f);const row = (await service.refresh()).agents[0];
  assert.equal(row.state,'unknown');assert.equal(row.canTest,true);
  assert.deepEqual(calls(f),[]);
  const tested = (await service.test('cc')).agents[0];
  assert.equal(tested.test.state,'failed');assert.match(tested.test.message,/升级/);
  assert.deepEqual(calls(f),[],'unsupported flags must never produce a model turn');
  f.env.CLAUDE_CLI = original;
});

test('test lock, failures and cancellation keep basic readiness intact', async t => {
  const f = fixture(t), service = availability(t,f,{testTimeoutMs:700});
  await service.refresh();fs.writeFileSync(f.mode,'hang');
  const pending = service.test('cc');
  assert.equal(service.snapshot().agents[0].test.state,'running');
  await assert.rejects(service.test('codex'),{code:'AI_BUSY'});
  await assert.rejects(service.refresh(),{code:'AI_BUSY'});
  const failed = (await pending).agents[0];
  assert.equal(failed.state,'detected');assert.equal(failed.test.state,'failed');assert.match(failed.test.message,/超时/);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_THINKING'));
  fs.writeFileSync(f.mode,'slow');
  const stopped = service.test('codex');service.dispose();
  assert.equal((await stopped).agents[1].test.state,'failed');
});

test('timed out process groups also kill descendants that ignore SIGTERM', {skip:process.platform === 'win32'}, async t => {
  const f = fixture(t), runner = createCommandRunner();t.after(() => runner.dispose());
  const marker = path.join(f.dir,'descendant-pid');
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = await runner.run(process.execPath,['-e',parent],{cwd:f.dir,env:f.env,timeoutMs:350});
  assert.equal(result.timedOut,true);
  const pid = Number(fs.readFileSync(marker,'utf8'));
  // SIGKILL is intentionally delayed to give a normal CLI time to exit.
  await new Promise(resolve => setTimeout(resolve,400));
  let alive = false;try { process.kill(pid,0);alive = true; } catch {}
  assert.equal(alive,false,'SIGTERM-ignoring descendant must not survive direct child exit');
});
