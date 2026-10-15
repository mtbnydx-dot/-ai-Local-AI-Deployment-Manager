@echo off
setlocal
rem Legacy name kept (06 6.6): platform start platform-mcp.
call "%~dp0platform.cmd" start platform-mcp
exit /b %ERRORLEVEL%
