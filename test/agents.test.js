const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {invokeAgent,resolveCli,saveCliPath,SELECTABLE_AGENTS,getSelectableAgent,resolveSelectableAgent} = require('../agents');
const {CODEX_HTTP_PROVIDER}=require('../agents/stream-protocol');

const {fixture} = require('./agent-fixture');

test('Trae entry stays closed while installed assistants and retained adapters keep working',t=>{
  const f=fixture(t),options={env:f.env,configDir:f.dir};
  assert.deepEqual(SELECTABLE_AGENTS,['cc','codex','codebuddy']);
  for(const id of SELECTABLE_AGENTS){assert.ok(getSelectableAgent(id));assert.equal(resolveSelectableAgent(id,options),id);}
  assert.throws(()=>getSelectableAgent('trae'),/AGENT_DISABLED:trae/);
  assert.equal(resolveSelectableAgent('trae',options),'codex');
  const noCodex={...options,env:{...f.env,CODEX_CLI:path.join(f.dir,'missing')}};
  assert.equal(resolveSelectableAgent('trae',noCodex),'codebuddy');
  assert.equal(resolveSelectableAgent('trae',{...options,env:{...noCodex.env,CODEBUDDY_CLI:path.join(f.dir,'missing')}}),'cc');
  assert.equal(resolveCli('trae',options),f.env.TRAE_CLI,'Retained Trae adapter and paths are not deleted');
});

test('all four adapters deliver stdin and only return the final answer',async t => {
  const f = fixture(t);
  const prompt = 'TASK=daily-digest\nINPUT_JSON\n'+JSON.stringify({period:{from:'2026-11-12',date:'2026-11-13'},records:[],tagCounts:{}})+'\nEND_INPUT_JSON';
  for (const id of ['cc','codex','codebuddy','trae']) {
    const result = JSON.parse(await invokeAgent(id,prompt,{cwd:f.dir,env:f.env}));
    assert.equal(typeof result.summary,'string');
  }
  const calls = fs.readFileSync(f.capture,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.agent),['cc','codex','codebuddy','trae']);
  const args = calls[1].argv;
  assert.equal(args[0],'app-server');assert.equal(args[args.indexOf('--listen')+1],'stdio://');
  assert.equal(args[args.indexOf('--config')+1],'model_reasoning_effort="medium"');
  assert.ok(args.includes(`model_providers.${CODEX_HTTP_PROVIDER}.supports_websockets=false`));
  assert.ok(args.includes(`model_provider="${CODEX_HTTP_PROVIDER}"`),'The HTTP provider must be selected before process startup');
  assert.equal(calls[1].modelProvider,CODEX_HTTP_PROVIDER);
  assert.deepEqual(calls[2].argv,['-p','--output-format','stream-json','--verbose','--include-partial-messages']);
  assert.deepEqual(calls[3].argv,['-c','default_permissions=":read-only"','-c','approval_policy="never"','acp','serve']);
});

test('Codex preserves custom endpoints and managed providers without resubmitting prompts',async t=>{
  const f=fixture(t);
  for(const [overrides,expected]of [
    [{MEMO_FAKE_CODEX_CONFIG:JSON.stringify({model_provider:'company-gateway'})},'company-gateway'],
    [{MEMO_FAKE_CODEX_CONFIG:JSON.stringify({openai_base_url:'https://gateway.example/v1'})},'openai'],
    // ChatGPT base routing is shared by both providers, including Codex's default value.
    [{MEMO_FAKE_CODEX_CONFIG:JSON.stringify({chatgpt_base_url:'https://chatgpt.com/backend-api'})},CODEX_HTTP_PROVIDER],
    [{OPENAI_BASE_URL:'https://gateway.example/v1'},'openai'],
    [{MEMO_FAKE_CODEX_HTTP_REJECT:'1'},'openai']
  ]) {
    const raw=await invokeAgent('codex','fictional book',{cwd:f.dir,env:{...f.env,...overrides}});
    assert.ok(JSON.parse(raw).habits.length);
    const calls=fs.readFileSync(f.capture,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.at(-1).modelProvider,expected);
  }
  assert.equal(fs.readFileSync(f.capture,'utf8').trim().split('\n').length,5,'Each task prompt is sent once');
});

test('invalid agents, missing CLI, partial failure and timeout reject cleanly',async t => {
  const f = fixture(t), options = {cwd:f.dir,env:f.env};
  await assert.rejects(invokeAgent('constructor','hello',options),/无效/);
  await assert.rejects(invokeAgent('codex','hello',{...options,env:{...f.env,CODEX_CLI:path.join(f.dir,'missing')}}),/AGENT_CLI_MISSING:codex/);
  fs.writeFileSync(f.mode,'partial-failure');
  await assert.rejects(invokeAgent('cc','hello',options),/unauthorized|AGENT_AUTH:cc/);
  fs.writeFileSync(f.mode,'hang');
  await assert.rejects(invokeAgent('codebuddy','hello',{...options,timeoutMs:350}),/超时/);
  fs.rmSync(f.mode);
  assert.ok(JSON.parse(await invokeAgent('cc','hello',options)).habits.length);
});

test('legacy paths and independently saved paths survive config reload',t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir,'claude-config.json'),JSON.stringify({claudePath:f.env.CLAUDE_CLI}));
  const env = {...f.env};delete env.CLAUDE_CLI;delete env.CODEX_CLI;delete env.CODEBUDDY_CLI;delete env.TRAE_CLI;
  assert.equal(resolveCli('cc',{env}),f.env.CLAUDE_CLI);
  saveCliPath('codex',f.env.CODEX_CLI,{configDir:f.dir,env});
  saveCliPath('codebuddy',f.env.CODEBUDDY_CLI,{configDir:f.dir,env});
  saveCliPath('trae',f.env.TRAE_CLI,{configDir:f.dir,env});
  delete env.CODEX_CLI;delete env.CODEBUDDY_CLI;delete env.TRAE_CLI;
  assert.equal(resolveCli('codex',{env}),f.env.CODEX_CLI);
  assert.equal(resolveCli('codebuddy',{env}),f.env.CODEBUDDY_CLI);
  assert.equal(resolveCli('trae',{env}),f.env.TRAE_CLI);
  assert.equal(resolveCli('cc',{env}),f.env.CLAUDE_CLI);
});

test('Trae rejects partial answers on failed, truncated or abruptly closed ACP turns',async t => {
  const f=fixture(t),options={cwd:f.dir,env:f.env,timeoutMs:5000};
  await assert.rejects(invokeAgent('trae','hello',{...options,env:{...f.env,TRAE_CLI:path.join(f.dir,'missing')}}),/AGENT_CLI_MISSING:trae/);
  for(const [mode,error] of [['partial-failure',/AGENT_AUTH:trae/],['acp-truncated',/未完整结束/],['acp-abrupt',/没有完整结束/]]) {
    fs.writeFileSync(f.mode,mode);
    await assert.rejects(invokeAgent('trae','fictional book',options),error);
  }
  fs.writeFileSync(f.mode,'hang');
  await assert.rejects(invokeAgent('trae','fictional book',{...options,timeoutMs:350}),/超时/);
  fs.rmSync(f.mode);
  assert.ok(JSON.parse(await invokeAgent('trae','fictional book',options)).habits.length);
});

