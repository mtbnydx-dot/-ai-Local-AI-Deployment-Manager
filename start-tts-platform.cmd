@echo off
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tts-platform\scripts\start_all.ps1" %*
exit /b %ERRORLEVEL%
