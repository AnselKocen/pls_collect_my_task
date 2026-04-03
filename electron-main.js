const { app, BrowserWindow, shell, dialog, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork, execFileSync } = require('child_process');

let mainWindow = null;
let serverProcess = null;
const PORT = 3013;

// --- Config Paths ---
function getConfigDir() {
  // In packaged app: ~/Library/Application Support/记忆手帐/
  // In dev: project dir
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return __dirname;
}

function getDataDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(__dirname, 'data');
}

function getConfigFile() {
  return path.join(getConfigDir(), 'claude-config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigFile(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
}

// --- CC Detection ---

// Packaged macOS apps launched from Finder have a minimal PATH (/usr/bin:/bin).
// Build a full PATH that includes common Node/Homebrew locations.
function getFullEnv() {
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    (process.env.HOME || '') + '/.nvm/current/bin',
    (process.env.HOME || '') + '/.local/bin',
  ];
  const currentPath = process.env.PATH || '';
  const fullPath = [...new Set([...extraPaths, ...currentPath.split(':')])].join(':');
  return { ...process.env, PATH: fullPath };
}

function findClaudeAuto() {
  // 1. Saved config
  const config = readConfig();
  if (config.claudePath && fs.existsSync(config.claudePath)) {
    return config.claudePath;
  }

  // 2. PATH (use login shell to get full PATH including homebrew etc.)
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const result = require('child_process').execSync(`${sh} -l -c "which claude"`, { encoding: 'utf-8', timeout: 5000, env: getFullEnv() }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}

  // 3. Common paths
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    (process.env.HOME || '') + '/.claude/local/claude',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

function verifyClaudePath(claudePath) {
  // Returns: { ok: true, version } or { ok: false, reason }
  if (!claudePath || !fs.existsSync(claudePath)) {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const ver = execFileSync(claudePath, ['--version'], { encoding: 'utf-8', timeout: 5000, env: getFullEnv() }).trim();
    if (ver) return { ok: true, version: ver };
    return { ok: false, reason: 'no_output' };
  } catch {
    return { ok: false, reason: 'not_executable' };
  }
}

// --- Dialogs ---
// Returns: claudePath string or null (user skipped)
function showSetupDialog(initialMessage) {
  // Dialog A: Main setup
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    title: 'Claude Code CLI',
    message: initialMessage || '未检测到 Claude Code CLI',
    detail:
      '本工具的 AI 功能（智能搜索、图谱、摘要等）需要 Claude Code CLI。\n' +
      '需要 Anthropic Max 订阅或 API Key。\n\n' +
      '安装方法：\n' +
      '1. 打开终端\n' +
      '2. 运行: npm install -g @anthropic-ai/claude-code\n' +
      '3. 运行: claude   (完成首次登录)\n\n' +
      '如果你已安装但未被识别，请点击「手动输入路径」。\n' +
      '（在终端运行 which claude 可查到路径）',
    buttons: ['手动输入路径', '跳过，先用基础功能'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result === 1) {
    // User skipped
    return null;
  }

  // User chose to input path — show input dialog
  return showPathInputLoop();
}

function showPathInputLoop() {
  // Electron doesn't have a native text input dialog, use file picker
  const files = dialog.showOpenDialogSync(mainWindow, {
    title: '选择 claude 可执行文件',
    message: '请选择 claude 可执行文件的位置\n（通常在 /opt/homebrew/bin/claude 或 /usr/local/bin/claude）',
    properties: ['openFile', 'showHiddenFiles'],
    defaultPath: '/opt/homebrew/bin/',
    buttonLabel: '选择此文件',
  });

  if (!files || files.length === 0) {
    // User cancelled file picker — ask what to do
    const retry = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      title: 'Claude CLI',
      message: '未选择文件',
      detail: '你可以重新选择，或跳过先使用基础功能。',
      buttons: ['重新选择', '跳过'],
      defaultId: 0,
      cancelId: 1,
    });
    if (retry === 0) return showPathInputLoop();
    return null;
  }

  const selectedPath = files[0];
  const check = verifyClaudePath(selectedPath);

  if (!check.ok) {
    // Dialog B/C: Invalid path or not executable
    const msg = check.reason === 'not_found'
      ? '路径无效，文件不存在'
      : 'Claude CLI 无法执行，可能需要重新安装';

    const retry = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: '验证失败',
      message: msg,
      detail: `路径：${selectedPath}`,
      buttons: ['重新选择', '跳过'],
      defaultId: 0,
      cancelId: 1,
    });
    if (retry === 0) return showPathInputLoop();
    return null;
  }

  // Dialog D: Success
  writeConfig({ claudePath: selectedPath });

  dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'Claude CLI 已配置',
    message: `已找到 Claude CLI (${check.version})`,
    detail:
      `路径：${selectedPath}\n` +
      `路径已保存，下次启动自动识别。\n\n` +
      `提醒：如果你还没登录过，请先在终端运行一次 claude 完成登录，\n` +
      `否则 AI 功能将无法使用。\n` +
      `（登录后不需要重启本应用）`,
    buttons: ['好的'],
  });

  return selectedPath;
}

// --- CC State ---
let ccConfigured = false;
let ccPath = null;

function checkAndSetupCC() {
  // Auto detect
  const autoPath = findClaudeAuto();
  if (autoPath) {
    const check = verifyClaudePath(autoPath);
    if (check.ok) {
      ccPath = autoPath;
      ccConfigured = true;
      // Save if not already saved
      const config = readConfig();
      if (config.claudePath !== autoPath) {
        writeConfig({ claudePath: autoPath });
      }
      return;
    }
  }

  // Not found — show dialog
  const userPath = showSetupDialog();
  if (userPath) {
    ccPath = userPath;
    ccConfigured = true;
  }
  // else: user skipped, ccConfigured stays false
}

// --- Server ---
function startServer() {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      MEMO_ELECTRON: '1',
      MEMO_DATA_DIR: getDataDir(),
    };
    // Pass CC path if configured
    if (ccPath) env.CLAUDE_CLI = ccPath;

    // In packaged app, server.js is in app.asar.unpacked (via asarUnpack config)
    let serverPath = path.join(__dirname, 'server.js');
    if (app.isPackaged) {
      serverPath = serverPath.replace('app.asar', 'app.asar.unpacked');
    }
    serverProcess = fork(serverPath, [], { env, silent: true });

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[Server]', msg.trim());
      if (msg.includes('Memo server running')) resolve();
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Error]', data.toString().trim());
    });

    serverProcess.on('error', (err) => {
      console.error('[Server] Failed to start:', err);
      resolve(); // Don't block app startup
    });

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Server exited with code ${code}`);
      }
    });

    // Timeout fallback
    setTimeout(resolve, 5000);
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

// --- IPC: Frontend asks if CC is configured ---
ipcMain.handle('cc-check', () => {
  return { configured: ccConfigured, path: ccPath };
});

ipcMain.handle('cc-setup', async () => {
  // Frontend triggered CC setup (user clicked AI button without CC)
  const userPath = showSetupDialog('AI 功能需要 Claude Code CLI');
  if (userPath) {
    ccPath = userPath;
    ccConfigured = true;
    // Restart server with new CC path
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
    await startServer();
    return { configured: true, path: ccPath };
  }
  return { configured: false };
});

// --- Data Directory Setup ---
function ensureDataDir() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  console.log(`[Data] Directory: ${dataDir}`);
}

// --- App Lifecycle ---
app.on('ready', async () => {
  ensureDataDir();
  checkAndSetupCC();
  await startServer();
  createWindow();
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
