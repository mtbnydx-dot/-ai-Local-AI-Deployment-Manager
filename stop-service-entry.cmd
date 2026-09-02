@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=@(5176,5177,5178);" ^
  "function Wait-PortClosed([int]$port) { for ($i=0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 250; $listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$listener) { return $true } }; return $false }" ^
  "foreach ($port in $ports) {" ^
  "  try { Invoke-RestMethod -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $port + '/api/manager/shutdown') -TimeoutSec 2 | Out-Null; if (Wait-PortClosed $port) { Write-Host ('Stopped manager on ' + $port) } else { Write-Warning ('Manager on ' + $port + ' did not close within timeout') } }" ^
  "  catch { Write-Host ('Manager on ' + $port + ' was not reachable or already stopped') }" ^
  "}" ^
  "Write-Host 'Model containers are not stopped by this script.'"
endlocal
