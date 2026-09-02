@echo off
setlocal
rem One command for the whole platform.
rem   start-platform.cmd            core: service entry + both managers (loopback entry)
rem   start-platform.cmd core lan   core with the entry bound to the LAN
rem   start-platform.cmd all        core + TTS gateway + MCP server + search gateway (Docker)
rem   start-platform.cmd all lan    same, entry on the LAN
rem Each component keeps its own script; this only sequences them and reports
rem what is still offline at the end. Set SERVICE_ENTRY_NO_BROWSER=1 to keep
rem the browser closed.
set "ROOT=%~dp0"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=core"
set "ENTRY_ARG="
if /I "%~2"=="lan" set "ENTRY_ARG=lan"
if /I "%MODE%"=="lan" (set "MODE=core" & set "ENTRY_ARG=lan")
set "FAILED="

echo == [1/4] Service entry + managers ==
call "%ROOT%start-service-entry.cmd" %ENTRY_ARG%
if errorlevel 1 set "FAILED=%FAILED% service-entry"

if /I not "%MODE%"=="all" goto :summary

echo.
echo == [2/4] TTS gateway ==
if exist "%ROOT%start-tts-platform.cmd" (
  call "%ROOT%start-tts-platform.cmd"
  if errorlevel 1 set "FAILED=%FAILED% tts"
) else (
  echo start-tts-platform.cmd not found; skipping TTS.
)

echo.
echo == [3/4] MCP server ==
if exist "%ROOT%start-platform-mcp.cmd" (
  call "%ROOT%start-platform-mcp.cmd"
  if errorlevel 1 set "FAILED=%FAILED% mcp"
) else (
  echo start-platform-mcp.cmd not found; skipping MCP.
)

echo.
echo == [4/4] Search gateway (Docker) ==
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is not running; the search gateway needs it. Start Docker Desktop, then run start-search-gateway.cmd.
  set "FAILED=%FAILED% search-gateway(docker-offline)"
) else (
  call "%ROOT%start-search-gateway.cmd"
  if errorlevel 1 set "FAILED=%FAILED% search-gateway"
)

:summary
echo.
echo ==================== platform status ====================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=@(@{Name='Service Entry';Port=5176},@{Name='vLLM Manager';Port=5177},@{Name='llama.cpp Manager';Port=5178},@{Name='TTS gateway';Port=7000},@{Name='MCP server';Port=5190},@{Name='Search gateway';Port=5180});" ^
  "$offline=@(); foreach ($p in $ports) { $l=Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; $state=if ($l) {'online'} else {'OFFLINE'}; if (!$l) { $offline+=$p.Name }; Write-Host (('{0,-20} {1,-6} {2}' -f $p.Name, $p.Port, $state)) }" ^
  "if ($offline.Count) { Write-Host ''; Write-Host ('Offline: ' + ($offline -join ', ')) } else { Write-Host ''; Write-Host 'All components are listening.' }"
if defined FAILED (
  echo Start steps that reported errors:%FAILED%
  exit /b 1
)
endlocal
exit /b 0
