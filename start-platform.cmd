@echo off
setlocal EnableDelayedExpansion
rem Legacy name kept (06 6.6): start-platform.cmd [core|all] [lan] is platform start [core|full] [--lan].
call "%~dp0platform.cmd" start %1 %2 --legacy-args
set "CODE=%ERRORLEVEL%"
set "LINE=!CMDCMDLINE!"
if /I not "%PLATFORM_NO_PAUSE%"=="1" if /I not "!LINE: /c =!"=="!LINE!" pause
endlocal & exit /b %CODE%
