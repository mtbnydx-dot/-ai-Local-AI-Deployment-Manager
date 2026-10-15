@echo off
setlocal
rem Legacy name kept (06 6.6): the gateway, plus the workers unless -GatewayOnly. -NoBrowser is accepted and ignored.
set "IDS=tts-gateway tts-workers"
for %%A in (%*) do if /I "%%~A"=="-GatewayOnly" set "IDS=tts-gateway"
call "%~dp0platform.cmd" start %IDS%
exit /b %ERRORLEVEL%
