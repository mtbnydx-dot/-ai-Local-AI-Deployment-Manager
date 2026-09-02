@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tts-platform\scripts\install_gateway.ps1" %*
exit /b %ERRORLEVEL%

