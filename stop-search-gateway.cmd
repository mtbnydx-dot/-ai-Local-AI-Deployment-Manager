@echo off
setlocal
set "ROOT=%~dp0"
set "SEARCH_ROOT=%ROOT%search-gateway"

docker compose -f "%SEARCH_ROOT%\docker-compose.yml" down

endlocal
