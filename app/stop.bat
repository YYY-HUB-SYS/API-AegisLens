@echo off
chcp 65001 >nul
rem 本文件必须保存为 UTF-8（无 BOM）+ CRLF 行尾；中文只能出现在 chcp 65001 之后
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，无法执行停止命令。
  pause
  exit /b 1
)
rem 只停 start.bat 起的那个实例：靠数据目录里的 server.pid 定位，并核对端口对得上
node server.js --stop
pause
