@echo off
setlocal
call "%~dp0start-subscription-proxy.cmd" lan
exit /b %ERRORLEVEL%
