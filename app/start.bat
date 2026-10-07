@echo off
chcp 65001 >nul
rem 本文件必须保存为 UTF-8（无 BOM）+ CRLF 行尾；中文只能出现在 chcp 65001 之后
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
rem start 打开的新控制台不继承本窗口代码页，需在子窗口内重新切换 UTF-8
start "API-AegisLens" cmd /k "chcp 65001 >nul & node server.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:37700
