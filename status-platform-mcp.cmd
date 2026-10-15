@echo off
setlocal
rem Legacy name kept (06 6.6): platform status platform-mcp.
call "%~dp0platform.cmd" status platform-mcp
exit /b %ERRORLEVEL%
