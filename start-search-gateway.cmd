@echo off
setlocal
set "ROOT=%~dp0"
set "SEARCH_ROOT=%ROOT%search-gateway"
set "SERVICE_KEY_FILE=%ROOT%vllm-manager\logs\.last-public-service-key.txt"

if not exist "%SEARCH_ROOT%\docker-compose.yml" (
  echo search-gateway docker-compose.yml not found.
  exit /b 1
)

if not defined UPSTREAM_BASE_URL set "UPSTREAM_BASE_URL=http://host.docker.internal:5177/serve/v1"
if not defined UPSTREAM_API_KEY if exist "%SERVICE_KEY_FILE%" set /p UPSTREAM_API_KEY=<"%SERVICE_KEY_FILE%"
if not defined SEARCH_GATEWAY_API_KEY if defined UPSTREAM_API_KEY set "SEARCH_GATEWAY_API_KEY=%UPSTREAM_API_KEY%"

echo Starting Local AI Search Gateway...
echo Compose file: %SEARCH_ROOT%\docker-compose.yml
echo.

docker compose -f "%SEARCH_ROOT%\docker-compose.yml" up -d --build
if errorlevel 1 (
  echo.
  echo Failed to start search gateway. Make sure Docker Desktop is running.
  exit /b 1
)

echo.
echo Search Gateway local: http://127.0.0.1:5180/v1
echo Direct search test:   http://127.0.0.1:5180/search?q=test
echo SearXNG local UI:     http://127.0.0.1:8180/
echo.
echo For LAN clients use:  http://^<this-machine-lan-ip^>:5180/v1

endlocal
