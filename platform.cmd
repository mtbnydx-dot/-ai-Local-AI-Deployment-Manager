@echo off
setlocal
set "PLATFORM_NODE=node"
if defined NODE_EXE set "PLATFORM_NODE=%NODE_EXE%"
where "%PLATFORM_NODE%" >nul 2>nul || (echo Node.js ^>=22.22.2 / 24.15+ is required. See docs\getting-started.md & exit /b 9009)
"%PLATFORM_NODE%" "%~dp0scripts\platformctl.js" %*
exit /b %ERRORLEVEL%
