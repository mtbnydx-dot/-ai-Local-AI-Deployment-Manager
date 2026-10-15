@echo off
setlocal
rem Legacy name kept (06 6.6): the entry and both managers.
call "%~dp0platform.cmd" status entry vllm-manager llama-manager
exit /b %ERRORLEVEL%
