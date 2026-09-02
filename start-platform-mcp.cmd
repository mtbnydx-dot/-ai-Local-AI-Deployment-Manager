@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-platform-mcp.ps1" -AiRoot "%~dp0."
exit /b %ERRORLEVEL%
