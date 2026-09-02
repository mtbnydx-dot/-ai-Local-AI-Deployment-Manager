@echo off
setlocal
set "ROOT=%~dp0"
set "SEARCH_ROOT=%ROOT%search-gateway"
set "SERVICE_KEY_FILE=%ROOT%vllm-manager\logs\.last-public-service-key.txt"

if not exist "%SEARCH_ROOT%\docker-compose.yml" (
  echo search-gateway docker-compose.yml not found.
  exit /b 1
)

rem Upstream selection (G2): prefer the entry's auto route so search-augmented
rem chat uses whichever manager currently serves the model. The container
rem reaches the host through host.docker.internal, which is not loopback, so
rem the entry route is only usable when the entry listens on the LAN
rem (start-service-entry.cmd lan). Otherwise fall back to the vLLM manager
rem gateway on 5177, which always binds 0.0.0.0. Set UPSTREAM_BASE_URL to
rem override either choice.
if defined UPSTREAM_BASE_URL goto :upstream_done
for /f "usebackq delims=" %%U in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$entry=Get-NetTCPConnection -LocalPort 5176 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } | Select-Object -First 1; if ($entry) { 'http://host.docker.internal:5176/gateway/auto/openai/v1' } else { 'http://host.docker.internal:5177/serve/v1' }"`) do set "UPSTREAM_BASE_URL=%%U"
if not defined UPSTREAM_BASE_URL set "UPSTREAM_BASE_URL=http://host.docker.internal:5177/serve/v1"
:upstream_done
if not defined UPSTREAM_API_KEY if exist "%SERVICE_KEY_FILE%" set /p UPSTREAM_API_KEY=<"%SERVICE_KEY_FILE%"
if not defined SEARCH_GATEWAY_API_KEY if defined UPSTREAM_API_KEY set "SEARCH_GATEWAY_API_KEY=%UPSTREAM_API_KEY%"

echo Starting Local AI Search Gateway...
echo Compose file: %SEARCH_ROOT%\docker-compose.yml
echo Upstream:     %UPSTREAM_BASE_URL%
echo.

docker compose -f "%SEARCH_ROOT%\docker-compose.yml" up -d --build
if errorlevel 1 (
  echo.
  echo Failed to start search gateway. Make sure Docker Desktop is running.
  exit /b 1
)

echo.
echo Search Gateway local: http://127.0.0.1:5180/v1
echo Via service entry:    http://127.0.0.1:5176/gateway/search/v1  (platform service key)
echo Direct search test:   http://127.0.0.1:5180/search?q=test
echo SearXNG local UI:     http://127.0.0.1:8180/
echo.
echo For LAN clients use:  http://^<this-machine-lan-ip^>:5180/v1

endlocal
