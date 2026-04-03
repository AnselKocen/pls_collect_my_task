@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set PID_FILE=.server.pid

if not exist "%PID_FILE%" (
    echo 服务未在运行
    exit /b 0
)

set /p PID=<"%PID_FILE%"
taskkill /PID %PID% /F >nul 2>&1
del "%PID_FILE%"
echo √ 服务已停止 (PID %PID%)
