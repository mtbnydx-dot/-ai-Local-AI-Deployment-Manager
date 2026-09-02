@echo off
setlocal
rem Prints which platform components are listening and the last exit-log lines
rem of anything that is offline.
set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=$env:ROOT;" ^
  "$items=@(" ^
  "  @{Name='Service Entry';Port=5176;Health='http://127.0.0.1:5176/api/status';ExitLog=(Join-Path $root 'service-entry\logs\process-exit.log')}," ^
  "  @{Name='vLLM Manager';Port=5177;Health='http://127.0.0.1:5177/api/manager/health';ExitLog=(Join-Path $root 'vllm-manager\logs\process-exit.log')}," ^
  "  @{Name='llama.cpp Manager';Port=5178;Health='http://127.0.0.1:5178/api/manager/health';ExitLog=(Join-Path $root 'llama-manager\logs\process-exit.log')}," ^
  "  @{Name='TTS gateway';Port=7000;Health='http://127.0.0.1:7000/health';ExitLog=''}," ^
  "  @{Name='MCP server';Port=5190;Health='http://127.0.0.1:5190/health';ExitLog=''}," ^
  "  @{Name='Search gateway';Port=5180;Health='http://127.0.0.1:5180/health';ExitLog=''}" ^
  ");" ^
  "foreach ($item in $items) {" ^
  "  $l=Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "  $health='-'; if ($l) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $item.Health -TimeoutSec 3; $health='HTTP ' + $r.StatusCode } catch { $health='health check failed' } }" ^
  "  $state=if ($l) { 'online  PID ' + $l.OwningProcess } else { 'OFFLINE' };" ^
  "  Write-Host (('{0,-20} {1,-6} {2,-18} {3}' -f $item.Name, $item.Port, $state, $health));" ^
  "  if (!$l -and $item.ExitLog -and (Test-Path -LiteralPath $item.ExitLog)) { Write-Host '    last exit-log lines:'; Get-Content -LiteralPath $item.ExitLog -Tail 3 | ForEach-Object { Write-Host ('    ' + $_) } }" ^
  "}"
endlocal
