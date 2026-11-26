@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo 未找到 Node.js，无法安全核验服务身份；请安装 Node.js 22.16 或更新版本后重试。
    exit /b 1
)
node service-control.js stop
if errorlevel 1 exit /b 1
