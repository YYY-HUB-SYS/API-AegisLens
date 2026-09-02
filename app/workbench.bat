@echo off
chcp 65001 >nul
rem 供 AI 工作台托管调用：前台运行 node，进程与日志由工作台管理；日常手动使用请改用 start.bat
cd /d "%~dp0"
node server.js
