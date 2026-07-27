@echo off
setlocal
set "STACK_MODE=local"
if /I "%~1"=="lan" set "STACK_MODE=lan"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0subscription-proxy-stack.ps1" -Action start -Mode "%STACK_MODE%"
exit /b %ERRORLEVEL%
