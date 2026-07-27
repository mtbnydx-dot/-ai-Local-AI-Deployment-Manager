@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0subscription-proxy-stack.ps1" -Action stop
exit /b %ERRORLEVEL%
