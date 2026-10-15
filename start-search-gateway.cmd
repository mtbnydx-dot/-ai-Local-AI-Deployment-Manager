@echo off
setlocal
rem Legacy name kept (06 6.6): platform start search-gateway.
call "%~dp0platform.cmd" start search-gateway
exit /b %ERRORLEVEL%
