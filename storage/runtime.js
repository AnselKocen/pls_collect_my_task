function checkRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`记忆手帐需要 Node.js 22.16 或更新版本，当前是 ${process.versions.node}。请升级 Node.js 后重新启动。桌面安装版已自带运行环境。`);
  }
  try {
    const sqlite = require('node:sqlite');
    if (typeof sqlite.DatabaseSync !== 'function' || typeof sqlite.backup !== 'function') throw new Error('SQLite API missing');
  } catch {
    throw new Error('当前运行环境没有内置 SQLite。请使用 Node.js 22.16+ 或新版桌面安装包。');
  }
}

module.exports = checkRuntime;
if (require.main === module) {
  try { checkRuntime(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
