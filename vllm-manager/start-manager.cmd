@echo off
setlocal
rem Legacy name kept (06 6.6): starts vllm-manager and opens its manager UI.
call "%~dp0..\platform.cmd" start vllm-manager
if errorlevel 1 (pause & exit /b 1)
call "%~dp0..\platform.cmd" open vllm
exit /b %ERRORLEVEL%
