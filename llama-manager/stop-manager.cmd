@echo off
setlocal
rem Legacy name kept (06 6.6): stops llama-manager; model containers are not touched.
call "%~dp0..\platform.cmd" stop llama-manager
exit /b %ERRORLEVEL%
