@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=@(5176,5177,5178);" ^
  "foreach ($port in $ports) {" ^
  "  try { Invoke-RestMethod -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $port + '/api/manager/shutdown') -TimeoutSec 2 | Out-Null; Write-Host ('Stopped manager on ' + $port) }" ^
  "  catch { Write-Host ('Manager on ' + $port + ' was not reachable or already stopped') }" ^
  "}" ^
  "Write-Host 'Model containers are not stopped by this script.'"
endlocal
