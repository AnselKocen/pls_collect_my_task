const { app, BrowserWindow, shell, dialog, ipcMain, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork, execFileSync } = require('child_process');

let mainWindow = null;
let serverProcess = null;
const PORT = Number(process.env.PORT || 3013);

// --- Config Paths ---
function getConfigDir() {
  if (process.env.MEMO_CONFIG_DIR) return path.resolve(process.env.MEMO_CONFIG_DIR);
  // In packaged app: ~/Library/Application Support/记忆手帐/
  // In dev: project dir
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return __dirname;
}

function getDataDir() {
  if (process.env.MEMO_DATA_DIR) return path.resolve(process.env.MEMO_DATA_DIR);
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(__dirname, 'data');
}

const { getAgent } = require('./agents');

// Finder launches apps with a minimal PATH; inherit the user's login-shell PATH once.
function getFullEnv() {
  let loginPath = '';
  if (process.platform !== 'win32') {
    try { loginPath = execFileSync(process.env.SHELL || '/bin/zsh',['-l','-c','printf "%s" "$PATH"'],{encoding:'utf8',timeout:3000}).trim(); } catch {}
  }
  const extraPaths = ['/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin',path.join(app.getPath('home'),'.local','bin')];
  const entries = [...(process.env.PATH || '').split(path.delimiter),...loginPath.split(path.delimiter),...extraPaths].filter(Boolean);
  return {...process.env,PATH:[...new Set(entries)].join(path.delimiter)};
}

function aiRequest(method,route,body) {
  return new Promise((resolve,reject) => {
    const payload = body && JSON.stringify(body);
    const request = require('http').request({hostname:'127.0.0.1',port:PORT,path:route,method,
      headers:{'Content-Type':'application/json','X-Memo-AI':'1',...(payload ? {'Content-Length':Buffer.byteLength(payload)} : {})}},response => {
      let text = '';
      response.on('data',chunk => {text+=chunk;});
      response.on('end',() => {
        try {
          const result = JSON.parse(text);
          if (response.statusCode >= 400) return reject(new Error(result.error || 'AI 助手配置失败'));
          resolve(result);
        } catch(error) {reject(error);}
      });
    });
    request.setTimeout(10000,() => request.destroy(new Error('AI 助手连接超时')));
    request.on('error',reject);request.end(payload);
  });
}

// --- Server ---
function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...getFullEnv(), MEMO_ELECTRON:'1', MEMO_DATA_DIR:getDataDir(), MEMO_CONFIG_DIR:getConfigDir() };
    let serverPath = path.join(__dirname,'server.js');
    if (app.isPackaged) serverPath = serverPath.replace('app.asar','app.asar.unpacked');
    const child = fork(serverPath, [], {env,silent:true});
    serverProcess = child;
    let ready = false;
    let errorOutput = '';
    const fail = error => {
      clearTimeout(timer);
      if (!ready) { child.kill(); reject(error); }
    };
    const timer = setTimeout(() => fail(new Error('数据库初始化超时，请关闭旧版应用并检查数据目录权限。')),60000);
    child.stdout.on('data', data => {
      const message = data.toString();
      console.log('[Server]',message.trim());
      if (!ready && message.includes('Memo server running')) {
        ready = true;clearTimeout(timer);resolve();
      }
    });
    child.stderr.on('data', data => {
      errorOutput = (errorOutput + data.toString()).slice(-4000);
      console.error('[Server]',data.toString().trim());
    });
    child.on('error',fail);
    child.on('exit', code => {
      clearTimeout(timer);
      if (!ready) reject(new Error(errorOutput || `本地服务启动失败（${code}）`));
    });
  });
}

// --- Window ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: '记忆手帐',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.js'),
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Cmd+R or Ctrl+R to refresh
    if ((input.meta || input.control) && input.key === 'r') {
      mainWindow.reload();
      event.preventDefault();
    }
    // Cmd+Shift+I or Ctrl+Shift+I for DevTools
    if ((input.meta || input.control) && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes(`localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Configuration applies to the currently selected assistant without restarting the server.
ipcMain.handle('ai-setup', async (event,id) => {
  const agent = getAgent(id);
  const status = await aiRequest('GET','/api/ai/status');
  if (status.agent !== id) throw new Error('AI 助手已切换，请重试');
  if (status.busy || status.maintenance) throw new Error('AI_BUSY:任务进行中，暂时不能配置助手');
  if (status.configured) return status;
  const {response} = await dialog.showMessageBox(mainWindow,{
    type:'info',title:agent.name,
    message:`未检测到 ${agent.name} CLI`,
    detail:`请先安装并在终端运行 ${agent.command} 完成登录。\n安装说明：${agent.install}\n\n已经安装的话，可以选择可执行文件。也可以回到设置，选择其他 AI 助手。`,
    buttons:['选择可执行文件','稍后配置'],defaultId:0,cancelId:1
  });
  if (response !== 0) return {configured:false};
  const {canceled,filePaths} = await dialog.showOpenDialog(mainWindow,{
    title:`选择 ${agent.name} 可执行文件`,properties:['openFile','showHiddenFiles'],buttonLabel:'选择此文件'
  });
  if (canceled || !filePaths.length) return {configured:false};
  return aiRequest('POST','/api/ai/path',{agent:id,path:filePaths[0]});
});

// --- Data Directory Setup ---
function ensureDataDir() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  console.log(`[Data] Directory: ${dataDir}`);
}

// --- System Notifications (poll server for pending reminders) ---
let notificationPoller = null;

function startNotificationPoller() {
  notificationPoller = setInterval(async () => {
    try {
      const http = require('http');
      const data = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${PORT}/api/scheduled/pending`, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
      });
      if (data.pending && data.pending.length > 0) {
        data.pending.forEach(p => {
          const notif = new Notification({
            title: '记忆手帐',
            body: p.message,
            silent: false,
          });
          notif.show();
        });
      }
    } catch {}
  }, 15000);
}

// --- App Lifecycle ---
app.whenReady().then(async () => {
  ensureDataDir();
  try {
    await startServer();
    createWindow();
    startNotificationPoller();
  } catch (error) {
    dialog.showErrorBox('本地数据服务启动失败',`${error.message}\n\n原始数据不会被自动清空。数据目录：${getDataDir()}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
