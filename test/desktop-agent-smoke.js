// Exercises the real Electron preload/IPC, native setup handler and forked backend.
const {app,BrowserWindow,dialog} = require('electron');
const fs = require('fs'),os = require('os'),path = require('path'),net = require('net');
const {once} = require('events'),assert = require('assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'memo-desktop-agent-'));
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const children = [], childProcess = require('child_process'), originalFork = childProcess.fork;
childProcess.fork = (...args) => {const child=originalFork(...args);children.push(child);return child;};
let window;
async function run() {
  const probe = net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port = probe.address().port;await new Promise(resolve => probe.close(resolve));
  const dataDir = path.join(root,'data');fs.mkdirSync(dataDir);
  const defaults = require('../storage/defaults')();defaults['settings.json'].agent='codebuddy';
  for(const [file,value] of Object.entries(defaults))fs.writeFileSync(path.join(dataDir,file),JSON.stringify(value));
  const fake = path.join(root,'chosen-codebuddy'),quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  fs.writeFileSync(fake,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname,'fake-model-cli.js'))} "$@"\n`,{mode:0o755});
  Object.assign(process.env,{PORT:String(port),MEMO_DATA_DIR:dataDir,MEMO_CONFIG_DIR:root,CODEBUDDY_CLI:path.join(root,'missing'),CLAUDE_CLI:path.join(root,'also-missing')});
  const shown=[];
  dialog.showMessageBox = async (parent,options) => {shown.push(options);return {response:0};};
  dialog.showOpenDialog = async () => ({canceled:false,filePaths:[fake]});
  const created = once(app,'browser-window-created');
  require('../electron-main');
  [,window] = await created;
  await once(window.webContents,'did-finish-load');
  const until = async expression => {
    for(let count=0;count<120;count++) {
      if(await window.webContents.executeJavaScript(expression))return;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    throw new Error('Desktop UI wait failed: '+expression);
  };
  await until('agentStatusKnown && settings.agent==="codebuddy"');
  assert.equal(shown.length,0,'Opening the app must not force Claude setup');
  const pid = children[0].pid;
  const available = await window.webContents.executeJavaScript('checkCCAvailable()');
  assert.equal(available,false);
  assert.equal(shown.length,1);assert.match(shown[0].message,/CodeBuddy/);assert.doesNotMatch(shown[0].detail,/Claude/);
  assert.equal(children.length,1,'Selecting a CLI path must not restart the server');assert.equal(children[0].pid,pid);
  const config = JSON.parse(fs.readFileSync(path.join(root,'ai-config.json'),'utf8'));
  assert.equal(config.paths.codebuddy,fake);
  await window.webContents.executeJavaScript('document.getElementById("digestRegenBtn").click()');
  await until('document.getElementById("digestRegenBtn").disabled');
  await until('!document.getElementById("digestRegenBtn").disabled && !document.getElementById("agentSelect").disabled');
  const suggestions = await (await fetch(`http://127.0.0.1:${port}/api/cc/suggestions`)).json();
  assert.ok(suggestions.dailyDigest);
  console.log(JSON.stringify({desktopStartup:true,selectedAgentSetup:true,nativePathSelection:true,noServerRestart:true,desktopGeneration:true}));
}
app.whenReady().then(run).catch(error => {console.error(error.stack);process.exitCode=1;}).finally(async () => {
  app.removeAllListeners('window-all-closed');
  for(const child of children) if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}
  window?.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode || 0);
});
