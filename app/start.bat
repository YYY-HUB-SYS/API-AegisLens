@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
start "AI Key Manager" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:37700
