@echo off
setlocal
rem Legacy name kept (06 6.6): platform stop platform-mcp.
call "%~dp0platform.cmd" stop platform-mcp
exit /b %ERRORLEVEL%
