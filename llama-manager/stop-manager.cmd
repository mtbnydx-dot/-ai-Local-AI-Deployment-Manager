@echo off
setlocal

set "ROOT=%~dp0"
set "PORT=5178"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root=$env:ROOT;" ^
  "$port=[int]$env:PORT;" ^
  "$pidFile=Join-Path $root '.manager.pid';" ^
  "function Wait-ManagerExit([int]$id) { for ($i=0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 250; if (!(Get-Process -Id $id -ErrorAction SilentlyContinue)) { return $true } }; return $false }" ^
  "if (!(Test-Path -LiteralPath $pidFile)) { Write-Host 'No manager pid file. Nothing to stop.'; exit 0 }" ^
  "$pidValue=Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "if (!($pidValue -as [int])) { Remove-Item -LiteralPath $pidFile -Force; Write-Host 'Invalid pid file removed.'; exit 0 }" ^
  "$managerPid=[int]$pidValue;" ^
  "$process=Get-Process -Id $managerPid -ErrorAction SilentlyContinue;" ^
  "$listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $managerPid } | Select-Object -First 1;" ^
  "if (!$process) { Write-Host ('Manager process is not running: ' + $managerPid); Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; Write-Host 'Model services were not touched.'; exit 0 }" ^
  "if (!$listener) { Write-Host ('PID ' + $managerPid + ' is not listening on manager port ' + $port + '; removing stale pid only.'); Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; Write-Host 'Model services were not touched.'; exit 0 }" ^
  "$url='http://127.0.0.1:' + $port + '/api/manager/shutdown';" ^
  "try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri $url -TimeoutSec 2 | Out-Null; Write-Host 'Requested graceful manager shutdown.' } catch { Write-Host ('Graceful shutdown request failed: ' + $_.Exception.Message) }" ^
  "if (Wait-ManagerExit $managerPid) { Write-Host ('Manager stopped gracefully: ' + $managerPid) } else { Stop-Process -Id $managerPid -Force -ErrorAction Stop; Write-Host ('Forced manager process stop after graceful timeout: ' + $managerPid) }" ^
  "Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host 'Model services were not touched.'"

if errorlevel 1 (
  echo.
  echo Failed to stop llama.cpp Manager cleanly.
  pause
  exit /b 1
)

endlocal
