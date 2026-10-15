@echo off
setlocal
rem Legacy name kept (06 6.6): platform start core [--lan]. SERVICE_ENTRY_NO_BROWSER=1 keeps the browser closed.
set "OPEN=--open" & if "%SERVICE_ENTRY_NO_BROWSER%"=="1" set "OPEN=--no-browser"
set "LAN=" & if /I "%~1"=="lan" set "LAN=--lan"
call "%~dp0platform.cmd" start core %LAN% %OPEN%
exit /b %ERRORLEVEL%
