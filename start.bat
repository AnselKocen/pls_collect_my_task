@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
if not defined PORT set "PORT=3013"
where node >nul 2>&1
if errorlevel 1 (
    echo 未找到 Node.js，请安装 Node.js 22.16 或更新版本：https://nodejs.org
    exit /b 1
)
node storage/runtime.js
if errorlevel 1 exit /b 1
if not exist "node_modules" (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo 缺少依赖且未找到 npm，请安装完整的 Node.js 后重试。
        exit /b 1
    )
    call npm install --no-fund --no-audit
    if errorlevel 1 exit /b 1
)
node service-control.js start
if errorlevel 1 exit /b 1
if not "%MEMO_NO_OPEN%"=="1" start "" "http://localhost:%PORT%"
