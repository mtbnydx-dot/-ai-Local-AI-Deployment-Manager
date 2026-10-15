@echo off
setlocal
rem Legacy name kept (06 6.6): stops the entry and both managers.
call "%~dp0platform.cmd" stop entry vllm-manager llama-manager
set "CODE=%ERRORLEVEL%"
echo Model containers are not stopped by this script.
endlocal & exit /b %CODE%
