@echo off
setlocal
rem One command for the whole platform.
rem   start-platform.cmd            core: service entry + both managers (loopback entry)
rem   start-platform.cmd core lan   core with the entry bound to the LAN
rem   start-platform.cmd all        core + TTS gateway + MCP server + search gateway (Docker)
rem   start-platform.cmd all lan    same, entry on the LAN
rem Each component keeps its own script; this only sequences them and prints
rem OK / FAILED / SKIPPED per component of the selected profile at the end.
rem   SERVICE_ENTRY_NO_BROWSER=1      keep the browser closed
rem   TTS_START_WORKERS=1             also start the TTS workers (default: gateway only)
rem   PLATFORM_DOCKER_WAIT_SECONDS=N  wait up to N seconds (default 90) for a
rem                                   Docker Desktop that is still starting
rem   PLATFORM_NO_PAUSE=1             never pause at the end (a double-click pauses)
set "ROOT=%~dp0"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=core"
set "ENTRY_ARG="
if /I "%~2"=="lan" set "ENTRY_ARG=lan"
if /I "%MODE%"=="lan" (set "MODE=core" & set "ENTRY_ARG=lan")
set "FAILED="
set "ST_TTS="
set "ST_MCP="
set "ST_SEARCH="
call :detectDoubleClick

echo == [1/4] Service entry + managers ==
call "%ROOT%start-service-entry.cmd" %ENTRY_ARG%
if errorlevel 1 set "FAILED=%FAILED% service-entry"

if /I not "%MODE%"=="all" goto :summary

echo.
echo == [2/4] TTS gateway ==
call :startTts

echo.
echo == [3/4] MCP server ==
if exist "%ROOT%start-platform-mcp.cmd" (
  call "%ROOT%start-platform-mcp.cmd"
  if errorlevel 1 set "FAILED=%FAILED% mcp"
) else (
  echo start-platform-mcp.cmd not found; skipping MCP.
  set "ST_MCP=SKIPPED start-platform-mcp.cmd not found"
)

echo.
echo == [4/4] Search gateway (Docker) ==
call :startSearch

:summary
echo.
echo ==================== platform status ====================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$all=($env:MODE -eq 'all');" ^
  "function Get-Port($name, [int]$default) { $value=[Environment]::GetEnvironmentVariable($name, 'Process') -as [int]; if ($value -ge 1 -and $value -le 65535) { return $value }; return $default }" ^
  "$items=@(" ^
  "  @{Name='Service Entry'; Port=(Get-Port 'SERVICE_ENTRY_PORT' 5176); Health='/gateway/health'; Core=$true; Step=''}," ^
  "  @{Name='vLLM Manager'; Port=(Get-Port 'VLLM_MANAGER_PORT' 5177); Health='/api/manager/health'; Core=$true; Step=''}," ^
  "  @{Name='llama.cpp Manager'; Port=(Get-Port 'LLAMA_MANAGER_PORT' 5178); Health='/api/manager/health'; Core=$true; Step=''}," ^
  "  @{Name='TTS gateway'; Port=(Get-Port 'TTS_GATEWAY_PORT' 7000); Health='/health'; Core=$false; Step=[string]$env:ST_TTS}," ^
  "  @{Name='MCP server'; Port=5190; Health='/health'; Core=$false; Step=[string]$env:ST_MCP}," ^
  "  @{Name='Search gateway'; Port=(Get-Port 'SEARCH_GATEWAY_PUBLIC_PORT' 5180); Health='/health'; Core=$false; Step=[string]$env:ST_SEARCH}" ^
  ");" ^
  "$bad=0;" ^
  "foreach ($item in $items) {" ^
  "  if (!$item.Core -and !$all) { continue }" ^
  "  if ($item.Step -match '^(SKIPPED|FAILED) (.*)$') { $state=$Matches[1]; $note=$Matches[2] }" ^
  "  else { $l=Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "    if (!$l) { $state='FAILED'; $note='not listening' }" ^
  "    else { $state='FAILED'; $note=('listening (PID ' + $l.OwningProcess + ') but ' + $item.Health + ' did not answer 2xx'); try { $r=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $item.Port + $item.Health) -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { $state='OK'; $note=('PID ' + $l.OwningProcess) } } catch {} } }" ^
  "  if ($state -eq 'FAILED') { $bad++ }" ^
  "  Write-Host (('{0,-20} {1,-6} {2,-8} {3}' -f $item.Name, $item.Port, $state, $note))" ^
  "}" ^
  "if ($bad) { exit 1 }"
set "PROBE_FAILED="
if errorlevel 1 set "PROBE_FAILED=1"
set "CODE=0"
if defined PROBE_FAILED set "CODE=1"
if defined FAILED echo Start steps that reported errors:%FAILED%
if defined FAILED set "CODE=1"
if defined PAUSE_AT_END (
  echo.
  pause
)
endlocal & exit /b %CODE%

:startTts
if not exist "%ROOT%start-tts-platform.cmd" (
  echo start-tts-platform.cmd not found; skipping TTS.
  set "ST_TTS=SKIPPED start-tts-platform.cmd not found"
  exit /b 0
)
rem The four workers load large models; they start only on request.
if "%TTS_START_WORKERS%"=="1" goto :startTtsWorkers
echo Starting the TTS gateway only. Set TTS_START_WORKERS=1 to start the workers too.
call "%ROOT%start-tts-platform.cmd" -GatewayOnly -NoBrowser
if errorlevel 1 set "FAILED=%FAILED% tts"
exit /b 0
:startTtsWorkers
call "%ROOT%start-tts-platform.cmd" -NoBrowser
if errorlevel 1 set "FAILED=%FAILED% tts"
exit /b 0

:startSearch
call :waitDocker
if errorlevel 2 (
  set "ST_SEARCH=FAILED Docker Desktop is not running"
  set "FAILED=%FAILED% search-gateway:docker-offline"
  exit /b 0
)
if errorlevel 1 (
  set "ST_SEARCH=FAILED Docker engine not ready after %DOCKER_WAIT_SECONDS% s"
  set "FAILED=%FAILED% search-gateway:docker-not-ready"
  exit /b 0
)
call "%ROOT%start-search-gateway.cmd"
if errorlevel 1 set "FAILED=%FAILED% search-gateway"
exit /b 0

:waitDocker
rem Exit 0: Docker answers. Exit 2: Docker Desktop is not running (hint at
rem once). Exit 1: Docker Desktop.exe runs but the engine did not answer
rem within PLATFORM_DOCKER_WAIT_SECONDS (default 90), polled every 3 s.
set "DOCKER_WAIT_SECONDS=%PLATFORM_DOCKER_WAIT_SECONDS%"
if not defined DOCKER_WAIT_SECONDS set "DOCKER_WAIT_SECONDS=90"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$limit=$env:DOCKER_WAIT_SECONDS -as [int]; if ($null -eq $limit -or $limit -lt 0) { $limit=90 };" ^
  "function Test-Docker { try { docker info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false } }" ^
  "if (Test-Docker) { exit 0 }" ^
  "if (!(Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) { Write-Host 'Docker Desktop is not running; the search gateway needs it. Start Docker Desktop, then run start-search-gateway.cmd.'; exit 2 }" ^
  "Write-Host ('Docker Desktop is starting; waiting up to ' + $limit + ' seconds for the Docker engine (PLATFORM_DOCKER_WAIT_SECONDS).');" ^
  "$deadline=(Get-Date).AddSeconds($limit); while (($left=($deadline - (Get-Date)).TotalMilliseconds) -gt 0) { Start-Sleep -Milliseconds ([int][math]::Min(3000, $left)); if (Test-Docker) { Write-Host 'Docker engine is ready.'; exit 0 } };" ^
  "Write-Host ('The Docker engine did not answer within ' + $limit + ' seconds. Run start-search-gateway.cmd once Docker Desktop has started.'); exit 1"
exit /b %ERRORLEVEL%

:detectDoubleClick
rem A double-click runs "cmd /c <script>", an open console does not; pause
rem only in the first case so the window does not vanish with the summary.
set "PAUSE_AT_END="
if "%PLATFORM_NO_PAUSE%"=="1" exit /b 0
setlocal EnableDelayedExpansion
set "CMD_LINE=!CMDCMDLINE!"
set "HIT="
if /I not "!CMD_LINE: /c =!"=="!CMD_LINE!" set "HIT=1"
endlocal & set "PAUSE_AT_END=%HIT%"
exit /b 0
