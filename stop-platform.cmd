@echo off
setlocal
rem Stops the platform processes started by start-platform.cmd.
rem   stop-platform.cmd        core: service entry + managers (model containers keep running)
rem   stop-platform.cmd all    core + TTS gateway + MCP server + search gateway containers
set "ROOT=%~dp0"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=core"

echo == Service entry + managers ==
call "%ROOT%stop-service-entry.cmd"

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

:done
echo.
echo Model containers are not stopped by this script.
endlocal
