const fs = require('fs');
const { randomUUID } = require('crypto');
const { createCodexSession, createPrintSession, CODEX_HTTP_PROVIDER, CODEX_HTTP_CONFIG } = require('./stream-protocol');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const AGENTS = Object.freeze({
  cc: { name:'Claude Code', command:'claude', env:'CLAUDE_CLI', install:'npm install -g @anthropic-ai/claude-code' },
  codex: { name:'Codex', command:'codex', env:'CODEX_CLI', install:'npm install -g @openai/codex' },
  codebuddy: { name:'CodeBuddy', command:'codebuddy', env:'CODEBUDDY_CLI', install:'https://www.workbuddy.cn/docs/cli/quickstart' }
});

function getAgent(id) {
  if (typeof id !== 'string' || !Object.hasOwn(AGENTS,id)) throw new Error('无效的 AI 助手');
  return AGENTS[id];
}

function configDirectory(env = process.env) {
  return env.MEMO_CONFIG_DIR || env.MEMO_DATA_DIR || path.resolve(__dirname,'..');
}

function readPaths(configDir = configDirectory()) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(configDir,'ai-config.json'),'utf8')).paths || {}; } catch {}
  // Keep the existing desktop installation's manually selected Claude path.
  if (!saved.cc) {
    try { saved.cc = JSON.parse(fs.readFileSync(path.join(configDir,'claude-config.json'),'utf8')).claudePath; } catch {}
  }
  return saved;
}

function executable(filename) {
  try {
    fs.accessSync(filename,process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch { return false; }
}

function resolveCli(id, { env = process.env, configDir = configDirectory(env) } = {}) {
  const agent = getAgent(id), home = env.HOME || env.USERPROFILE || '';
  const names = process.platform === 'win32' ? [agent.command+'.exe',agent.command+'.cmd',agent.command] : [agent.command];
  const directories = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin','/usr/local/bin','/usr/bin',path.join(home,'.local','bin'),
    path.join(home,'.'+agent.command,'local'),
    ...(env.APPDATA ? [path.join(env.APPDATA,'npm'),path.join(env.APPDATA,agent.command)] : []),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA,'Programs',agent.command)] : [])
  ];
  const saved = readPaths(configDir)[id];
  // An explicit environment override is authoritative, including invalid paths.
  if (env[agent.env]) return executable(env[agent.env]) ? env[agent.env] : null;
  const candidates = [saved,...directories.flatMap(dir => names.map(name => path.join(dir,name)))];
  if (id === 'codex' && process.platform === 'darwin') candidates.push(
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  );
  return candidates.find(candidate => candidate && executable(candidate)) || null;
}

// Prompts always travel over stdin. Only fixed CLI flags and generated paths are arguments.
function launch(command,args,options = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = value => '"'+String(value).replace(/"/g,'""')+'"';
    return spawn(quote(command),args.map(quote),{...options,shell:true,windowsHide:true});
  }
  return spawn(command,args,{...options,windowsHide:true});
}

function saveCliPath(id, filename, { configDir = configDirectory(), env = process.env } = {}) {
  const agent = getAgent(id);
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !executable(filename)) throw new Error(`AGENT_CLI_MISSING:${id}`);
  const version = process.platform === 'win32' && /\.(cmd|bat)$/i.test(filename)
    ? execFileSync(process.env.ComSpec || 'cmd.exe',['/d','/s','/c',`""${filename}" --version"`],{env,encoding:'utf8',timeout:5000,windowsHide:true})
    : execFileSync(filename,['--version'],{env,encoding:'utf8',timeout:5000,windowsHide:true});
  if (!version.trim()) throw new Error(`AGENT_CLI_MISSING:${id}`);
  const paths = readPaths(configDir);
  paths[id] = filename;
  fs.mkdirSync(configDir,{recursive:true});
  const file = path.join(configDir,'ai-config.json'), temporary = file+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({paths},null,2),{mode:0o600});
  fs.renameSync(temporary,file);
  // Match the user's explicit file choice for this process as well.
  env[agent.env] = filename;
}

const children = new Set();
function killTree(child,signal = 'SIGTERM') {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true,timeout:3000});
    } else process.kill(-child.pid,signal);
  } catch { try { child.kill(signal); } catch {} }
}
function stopAgents() { for (const child of children) killTree(child); }

// Codex requires the provider to be selected at process startup, before a thread
// exists. Inspect effective settings/policy in a short, prompt-free connection.
function canUseCodexHTTP(command,{cwd,env,timeoutMs}) {
  if(env.OPENAI_BASE_URL || env.OPENAI_API_BASE || env.CODEX_CHATGPT_BASE_URL)return Promise.resolve(false);
  return new Promise((resolve,reject)=>{
    const child=launch(command,['app-server','--listen','stdio://'],{cwd,env,stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32'});
    children.add(child);
    let config,requirements,buffer='',closing=false,selection=false,grace,hardKill;
    const send=row=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(row)+'\n');};
    const finish=value=>{
      if(closing)return;
      closing=true;selection=value;clearTimeout(timer);child.stdin.end();
      grace=setTimeout(()=>{killTree(child);hardKill=setTimeout(()=>killTree(child,'SIGKILL'),1000);hardKill.unref();},300);grace.unref();
    };
    const timer=setTimeout(()=>finish(false),Math.min(timeoutMs,5000));
    child.stdin.on('error',()=>{});child.on('error',()=>finish(false));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data=>{
      buffer+=data;let boundary;
      while(!closing && (boundary=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);let row;
        try{row=JSON.parse(line);}catch{continue;}
        if(row.id===1) {
          if(row.error){finish(false);continue;}
          send({method:'initialized'});
          send({id:2,method:'config/read',params:{includeLayers:false,cwd}});
          send({id:3,method:'configRequirements/read',params:{}});
        } else if(row.id===2 || row.id===3) {
          if(row.error || !row.result){finish(false);continue;}
          if(row.id===2)config=row.result.config;
          else requirements=row.result.requirements || null;
          if(config && requirements!==undefined)finish(
            (!config.model_provider || config.model_provider==='openai') && !config.openai_base_url
            && !requirements?.modelProvider && !requirements?.modelProviders
          );
        }
      }
      if(buffer.length>1024*1024)finish(false);
    });
    child.on('close',(_code,signal)=>{
      clearTimeout(timer);clearTimeout(grace);clearTimeout(hardKill);children.delete(child);
      if(!closing && signal)return reject(new Error('AI 调用已停止'));
      resolve(selection);
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'memo_journal',title:'记忆手帐',version:'1.0.0'},capabilities:{}}});
  });
}

async function invokeAgent(id,prompt,{cwd,env = process.env,configDir = configDirectory(env),timeoutMs = 300000,onEvent = () => {}} = {}) {
  const started=Date.now();
  const command=resolveCli(id,{env,configDir});
  if(!command)throw new Error(`AGENT_CLI_MISSING:${id}`);
  const callId=randomUUID();
  const emit=event => onEvent({...event,...(event.messageId ? {messageId:callId+':'+event.messageId} : {})});
  emit({type:'stage',label:`正在连接 ${getAgent(id).name}`});
  const useHTTP=id==='codex' && await canUseCodexHTTP(command,{cwd,env,timeoutMs});
  const overrides=['model_reasoning_effort="medium"',...(useHTTP ? [`model_provider="${CODEX_HTTP_PROVIDER}"`,...CODEX_HTTP_CONFIG] : [])];
  const args=id==='codex'
    ? ['app-server','--listen','stdio://',...overrides.flatMap(value=>['--config',value])]
    : ['-p','--output-format','stream-json','--verbose','--include-partial-messages'];
  return new Promise((resolve,reject) => {
    const child=launch(command,args,{cwd,env:{...env,CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1'},stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    children.add(child);
    let buffer='',stderr='',failure=null,result=null,hardKill,graceTimer,received=false,outputSize=0;
    const stop=() => {
      if(id==='codex')child.stdin.end();
      graceTimer=setTimeout(() => {
        killTree(child);
        hardKill=setTimeout(() => killTree(child,'SIGKILL'),1000);hardKill.unref();
      },id==='codex' ? 500 : 1000);graceTimer.unref();
    };
    const fail=error => {
      if(failure)return;
      failure=error instanceof Error ? error : new Error(String(error));
      killTree(child);hardKill=setTimeout(() => killTree(child,'SIGKILL'),1000);hardKill.unref();
    };
    const finish=text => {
      if(failure || result!==null)return;
      if(typeof text!=='string' || !text.trim())return fail(new Error('AI 没有返回有效内容'));
      if(text.length>4*1024*1024)return fail(new Error('AI 返回内容过长'));
      result=text.trim();
      if(id==='codex')stop(); // Print-mode CLIs exit themselves after their result event.
    };
    const forward=event => {
      if(failure || result!==null)return;
      if(event.type==='delta') {
        outputSize+=event.text.length;
        if(outputSize>4*1024*1024)return fail(new Error('AI 返回内容过长'));
        if(!received){received=true;emit({type:'stage',label:'正在接收回答'});}
      }
      emit(event);
    };
    const send=row => {if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(row)+'\n');};
    const session=(id==='codex' ? createCodexSession : createPrintSession)({send,emit:forward,finish,fail,prompt,cwd,env});
    const timer=setTimeout(() => fail(new Error('AI 调用超时')),Math.max(1,timeoutMs-(Date.now()-started)));
    function line(text) {
      if(!text.trim() || failure || result!==null)return;
      try {session.message(JSON.parse(text));}
      catch(error) {fail(new Error('无法读取助手的流式输出：'+error.message));}
    }
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',data => {
      buffer+=data;
      let boundary;
      while((boundary=buffer.indexOf('\n'))>=0){const row=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);line(row);}
      if(buffer.length>4*1024*1024)fail(new Error('AI 返回内容过长'));
    });
    child.stderr.on('data',data => {stderr=(stderr+data).slice(-65536);});
    child.stdin.on('error',() => {});
    child.on('error',error => {failure=error;});
    child.on('close',(code,signal) => {
      if(buffer.trim())line(buffer);
      clearTimeout(timer);clearTimeout(hardKill);clearTimeout(graceTimer);children.delete(child);
      if(failure)return reject(failure);
      if(result!==null && (id==='codex' || code===0))return resolve(result);
      const auth=/authentication|unauthorized|not logged|sign.?in|log.?in|登录/i.test(stderr);
      if(code!==0)console.error(`[AI:${id}] exit=${code} signal=${signal}`);
      reject(new Error(auth ? `AGENT_AUTH:${id}` : code!==0 ? `AI 调用失败 (${id}, ${code}): ${stderr}` : 'AI 流式任务没有完整结束，本次结果未保存'));
    });
    session.start();
    if(id!=='codex')child.stdin.end(prompt);
  });
}

module.exports = {AGENTS,getAgent,configDirectory,resolveCli,saveCliPath,invokeAgent,stopAgents};
