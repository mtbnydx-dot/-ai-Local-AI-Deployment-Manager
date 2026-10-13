@echo off
setlocal
rem Stops the service entry and both managers. Each one first gets a graceful
rem POST /api/manager/shutdown. A port that still listens after 10 seconds is
rem force-stopped through the PID in that component's .manager.pid, but only
rem when CIM shows the PID is a node process with server.js in its command
rem line and it owns the port; anything else is reported, left alone, and the
rem script exits 1. SERVICE_ENTRY_PORT, VLLM_MANAGER_PORT and
rem LLAMA_MANAGER_PORT override the default ports 5176-5178.
set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=$env:ROOT;" ^
  "function Get-PortSetting($name, [int]$default) { $raw=[Environment]::GetEnvironmentVariable($name, 'Process'); if ([string]::IsNullOrWhiteSpace($raw)) { return $default }; $value=$raw -as [int]; if (!$value -or $value -lt 1 -or $value -gt 65535) { throw ($name + ' must be a port number between 1 and 65535: ' + $raw) }; return $value }" ^
  "$items=@(" ^
  "  @{Name='Service Entry'; Root=(Join-Path $root 'service-entry'); Port=(Get-PortSetting 'SERVICE_ENTRY_PORT' 5176)}," ^
  "  @{Name='vLLM Manager'; Root=(Join-Path $root 'vllm-manager'); Port=(Get-PortSetting 'VLLM_MANAGER_PORT' 5177)}," ^
  "  @{Name='llama.cpp Manager'; Root=(Join-Path $root 'llama-manager'); Port=(Get-PortSetting 'LLAMA_MANAGER_PORT' 5178)}" ^
  ");" ^
  "function Get-Listener([int]$port) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }" ^
  "function Wait-PortClosed([int]$port, [int]$seconds) { $deadline=(Get-Date).AddSeconds($seconds); while ((Get-Date) -lt $deadline) { if (!(Get-Listener $port)) { return $true }; Start-Sleep -Milliseconds 250 }; return !(Get-Listener $port) }" ^
  "$failed=@();" ^
  "foreach ($item in $items) {" ^
  "  $port=$item.Port;" ^
  "  if (!(Get-Listener $port)) { Write-Host ($item.Name + ' on ' + $port + ' is not running.'); continue }" ^
  "  try { Invoke-RestMethod -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $port + '/api/manager/shutdown') -TimeoutSec 2 | Out-Null } catch { Write-Host ($item.Name + ' on ' + $port + ' did not accept the shutdown request: ' + $_.Exception.Message) }" ^
  "  if (Wait-PortClosed $port 10) { Write-Host ('Stopped ' + $item.Name + ' on ' + $port); continue }" ^
  "  $pidFile=Join-Path $item.Root '.manager.pid'; $pidValue=$null;" ^
  "  if (Test-Path -LiteralPath $pidFile) { $pidValue=Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1 }" ^
  "  $proc=$null; if ($pidValue -as [int]) { $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$pidValue) -ErrorAction SilentlyContinue }" ^
  "  $owner=Get-Listener $port; $what=if ($pidValue) { 'PID ' + $pidValue + ' from ' + $pidFile + ' is not the node server.js process that owns the port' } else { $pidFile + ' holds no PID' };" ^
  "  if (!$proc -or $proc.Name -notmatch '^node(\.exe)?$' -or [string]$proc.CommandLine -notmatch 'server\.js' -or !$owner -or $owner.OwningProcess -ne $proc.ProcessId) { Write-Warning ($item.Name + ' on ' + $port + ' is still listening after 10 seconds, and ' + $what + '. Nothing was killed.'); $failed+=$item.Name; continue }" ^
  "  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue;" ^
  "  if (Wait-PortClosed $port 5) { Write-Host ('Force-stopped ' + $item.Name + ' PID ' + $proc.ProcessId + ' on ' + $port + ' after the graceful shutdown timed out.') } else { Write-Warning ($item.Name + ' on ' + $port + ' is still listening after a forced stop of PID ' + $proc.ProcessId + '.'); $failed+=$item.Name }" ^
  "}" ^
  "Write-Host 'Model containers are not stopped by this script.';" ^
  "if ($failed.Count) { Write-Host ('Not stopped: ' + ($failed -join ', ')); exit 1 }"
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
