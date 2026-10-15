@echo off
setlocal
rem Legacy name kept (06 6.6): platform status.
call "%~dp0platform.cmd" status
exit /b %ERRORLEVEL%
