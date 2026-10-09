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
rem 后台起服务：进程脱离本窗口，关掉这个窗口不会把服务一起带走
node server.js --daemon
if errorlevel 1 (
  echo 没有新建后台实例；若已有服务在跑，直接访问下面的地址即可。
  echo 确实要重启：先双击 stop.bat，再双击本文件。
)
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:37700
echo 地址：http://127.0.0.1:37700    停止：双击 stop.bat
echo 浏览器打不开就用前台模式看原因：node server.js
pause
