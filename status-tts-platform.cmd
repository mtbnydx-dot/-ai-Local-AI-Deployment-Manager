@echo off
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tts-platform\scripts\status.ps1"
exit /b %ERRORLEVEL%
