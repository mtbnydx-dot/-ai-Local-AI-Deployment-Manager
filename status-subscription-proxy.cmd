@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0subscription-proxy-stack.ps1" -Action status
exit /b %ERRORLEVEL%
