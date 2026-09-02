@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-platform.ps1" %*
exit /b %ERRORLEVEL%

