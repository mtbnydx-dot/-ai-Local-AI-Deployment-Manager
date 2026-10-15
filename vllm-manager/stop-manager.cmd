@echo off
setlocal
rem Legacy name kept (06 6.6): stops vllm-manager; model containers are not touched.
call "%~dp0..\platform.cmd" stop vllm-manager
exit /b %ERRORLEVEL%
