@echo off
chcp 65001 >nul 2>&1
title 记忆手帐

cd /d "%~dp0"

set PORT=3013
set PID_FILE=.server.pid

echo.
echo   ☕ 记忆手帐 — 环境检查
echo   --------------------------------

set FAIL=0

:: --- 1. Check Node.js ---
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    node storage/runtime.js
    if errorlevel 1 (
        echo   请升级 Node.js 后重新启动。
        pause
        exit /b 1
    )
    for /f "tokens=*" %%v in ('node -v') do echo   √ Node.js %%v
) else (
    echo   ✗ 未找到 Node.js
    echo.
    echo     请先安装 Node.js [v22.16+]:
    echo     -^> https://nodejs.org
    echo     下载 LTS 版本，安装后重新运行此脚本
    echo.
    set FAIL=1
)

:: AI assistants are optional and selected in the app settings.
if %FAIL% neq 0 (
    echo   请安装 Node.js 后重新运行。
    pause
    exit /b 1
)
echo   AI 助手可在设置中选择 cc / codex / codebuddy，请安装并登录所选 CLI。

:: --- 3. Check node_modules ---
if not exist "node_modules" (
    echo   ⟳ 首次运行，正在安装依赖...
    call npm install --no-fund --no-audit
    echo   √ 依赖安装完成
) else (
    echo   √ 依赖已就绪
)

echo   --------------------------------

:: --- 4. Check if already running ---
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    tasklist /FI "PID eq %OLD_PID%" 2>nul | find "%OLD_PID%" >nul
    if %ERRORLEVEL% equ 0 (
        echo   服务已在运行 [PID %OLD_PID%]
        start http://localhost:%PORT%
        exit /b 0
    ) else (
        del "%PID_FILE%"
    )
)

:: --- 5. Start server in background ---
echo   启动服务...
start /b node server.js > .server.log 2>&1
timeout /t 2 /nobreak >nul

:: Get PID by looking up which process is listening on our port.
:: This is reliable even when multiple node.exe processes are running,
:: because only our server.js can be listening on port %PORT%.
set SERVER_PID=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    if not defined SERVER_PID (
        set SERVER_PID=%%p
        echo %%p> "%PID_FILE%"
    )
)

:: --- 6. Wait for server ---
set READY=0
for /l %%i in (1,1,15) do (
    if %READY% equ 0 (
        curl -s http://localhost:%PORT% >nul 2>&1
        if %ERRORLEVEL% equ 0 (
            set READY=1
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

:: --- 7. Open browser ---
start http://localhost:%PORT%

echo.
echo   --------------------------------
echo   ☕ 记忆手帐已在后台运行！
echo      地址: http://localhost:%PORT%
echo      日志: type .server.log
echo      停止: stop.bat
echo   --------------------------------
echo.
