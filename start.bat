@echo off
chcp 65001 >nul 2>&1
title 记忆手帐

cd /d "%~dp0"

set PORT=3013
set PID_FILE=.server.pid

echo.
echo   ☕ 记忆手帐 — 环境检查
echo   ────────────────────────────────

set FAIL=0

:: --- 1. Check Node.js ---
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for /f "tokens=*" %%v in ('node -v') do echo   √ Node.js %%v
) else (
    echo   ✗ 未找到 Node.js
    echo.
    echo     请先安装 Node.js (v18+):
    echo     → https://nodejs.org
    echo     下载 LTS 版本，安装后重新运行此脚本
    echo.
    set FAIL=1
)

:: --- 2. Check Claude CLI ---
set CLAUDE_FOUND=0
if defined CLAUDE_CLI (
    if exist "%CLAUDE_CLI%" (
        set CLAUDE_FOUND=1
        echo   √ Claude CLI (自定义路径: %CLAUDE_CLI%)
    )
)
if %CLAUDE_FOUND% equ 0 (
    where claude >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        set CLAUDE_FOUND=1
        echo   √ Claude CLI (PATH)
    )
)
if %CLAUDE_FOUND% equ 0 (
    if exist "%APPDATA%\claude\claude.exe" (
        set CLAUDE_FOUND=1
        echo   √ Claude CLI (%APPDATA%\claude\claude.exe)
    )
)
if %CLAUDE_FOUND% equ 0 (
    if exist "%LOCALAPPDATA%\Programs\claude\claude.exe" (
        set CLAUDE_FOUND=1
        echo   √ Claude CLI (%LOCALAPPDATA%\Programs\claude\claude.exe)
    )
)
if %CLAUDE_FOUND% equ 0 (
    echo   未自动找到 Claude CLI
    echo.
    echo     如果你已经安装了，请输入 claude.exe 的完整路径
    echo     例如 C:\Users\你的用户名\AppData\Roaming\claude\claude.exe
    echo     直接回车跳过:
    set /p USER_PATH="    路径: "
    if defined USER_PATH (
        if exist "%USER_PATH%" (
            set CLAUDE_FOUND=1
            set CLAUDE_CLI=%USER_PATH%
            echo   √ Claude CLI (%USER_PATH%)
        ) else (
            echo   路径不存在: %USER_PATH%
        )
    )
    if %CLAUDE_FOUND% equ 0 (
        echo.
        echo   ✗ 未找到 Claude CLI
        echo.
        echo     请先安装 Claude CLI:
        echo     → npm install -g @anthropic-ai/claude-code
        echo.
        echo     安装后请在终端运行一次 claude 完成首次登录
        echo     (需要登录你的 Anthropic 账号，否则 AI 功能无法使用^)
        echo.
        set FAIL=1
    )
)

:: --- Exit if checks failed ---
if %FAIL% neq 0 (
    echo   ────────────────────────────────
    echo   提示：本工具的 AI 功能依赖 Claude Code CLI
    echo   需要 Anthropic Max 订阅 或 API Key 才能使用
    echo   详情：https://docs.anthropic.com/en/docs/claude-code
    echo.
    echo   环境检查未通过，请完成上述准备后再重新运行
    echo.
    pause
    exit /b 1
)

:: --- 3. Check node_modules ---
if not exist "node_modules" (
    echo   ⟳ 首次运行，正在安装依赖...
    call npm install --no-fund --no-audit
    echo   √ 依赖安装完成
) else (
    echo   √ 依赖已就绪
)

echo   ────────────────────────────────

:: --- 4. Check if already running ---
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    tasklist /FI "PID eq %OLD_PID%" 2>nul | find "%OLD_PID%" >nul
    if %ERRORLEVEL% equ 0 (
        echo   服务已在运行 (PID %OLD_PID%)
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
echo   ────────────────────────────────
echo   ☕ 记忆手帐已在后台运行！
echo      地址: http://localhost:%PORT%
echo      日志: type .server.log
echo      停止: stop.bat
echo   ────────────────────────────────
echo.
