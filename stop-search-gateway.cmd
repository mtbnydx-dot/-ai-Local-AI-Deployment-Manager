@echo off
setlocal
rem Legacy name kept (06 6.6): platform stop search-gateway.
call "%~dp0platform.cmd" stop search-gateway
exit /b %ERRORLEVEL%
