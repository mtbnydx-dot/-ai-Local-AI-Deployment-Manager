@echo off
setlocal
rem Legacy name kept (06 6.6): stop-platform.cmd [all] is platform stop core|all.
call "%~dp0platform.cmd" stop %1 --legacy-args
exit /b %ERRORLEVEL%
