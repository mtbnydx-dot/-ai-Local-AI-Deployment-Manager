@echo off
setlocal
rem Stops the platform processes started by start-platform.cmd.
rem   stop-platform.cmd        core: service entry + managers (model containers keep running)
rem   stop-platform.cmd all    core + TTS gateway and workers + MCP server + search gateway containers
rem Exits 1 when a step could not stop its component; the other steps still run.
set "ROOT=%~dp0"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=core"
set "FAILED="

echo == Service entry + managers ==
call "%ROOT%stop-service-entry.cmd"
if errorlevel 1 set "FAILED=%FAILED% service-entry"

if /I not "%MODE%"=="all" goto :done

echo.
echo == MCP server ==
if exist "%ROOT%stop-platform-mcp.cmd" call "%ROOT%stop-platform-mcp.cmd"

echo.
echo == Search gateway ==
if exist "%ROOT%stop-search-gateway.cmd" call "%ROOT%stop-search-gateway.cmd"

echo.
echo == TTS gateway ==
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tts-platform\scripts\stop_gateway.ps1"
if errorlevel 1 set "FAILED=%FAILED% tts-gateway"

echo.
echo == TTS workers ==
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tts-platform\scripts\stop_workers.ps1"
if errorlevel 1 set "FAILED=%FAILED% tts-workers"

:done
echo.
echo Model containers are not stopped by this script.
set "CODE=0"
if defined FAILED echo Stop steps that reported errors:%FAILED%
if defined FAILED set "CODE=1"
endlocal & exit /b %CODE%
