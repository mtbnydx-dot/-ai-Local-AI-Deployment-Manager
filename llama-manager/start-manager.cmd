@echo off
setlocal
rem Legacy name kept (06 6.6): starts llama-manager and opens its manager UI.
call "%~dp0..\platform.cmd" start llama-manager
if errorlevel 1 (pause & exit /b 1)
call "%~dp0..\platform.cmd" open llama
exit /b %ERRORLEVEL%
