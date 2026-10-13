@echo off
setlocal

set "ROOT=%~dp0"
if not defined NODE_EXE set "NODE_EXE=node"
rem An existing LLAMA_MANAGER_PORT wins, so a second copy (for example a check
rem in a worktree) can run beside the live manager. The previous runs' logs are
rem kept as logs\manager.out.1.log .. .3.log (manager.err.log likewise).
if not defined LLAMA_MANAGER_PORT set "LLAMA_MANAGER_PORT=5178"
set "PORT=%LLAMA_MANAGER_PORT%"
set "URL=http://127.0.0.1:%LLAMA_MANAGER_PORT%"
set "LLAMA_MANAGER_HOST=0.0.0.0"

if not exist "%ROOT%logs" mkdir "%ROOT%logs"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root=$env:ROOT;" ^
  "$node=$env:NODE_EXE;" ^
  "$url=$env:URL;" ^
  "if (!($env:PORT -as [int]) -or [int]$env:PORT -lt 1 -or [int]$env:PORT -gt 65535) { throw ('LLAMA_MANAGER_PORT must be a port number between 1 and 65535: ' + $env:PORT) }" ^
  "$port=[int]$env:PORT;" ^
  "$pidFile=Join-Path $root '.manager.pid';" ^
  "$server=Join-Path $root 'server.js';" ^
  "function Rotate-Log($file, [int]$keep) { if (!(Test-Path -LiteralPath $file)) { return }; for ($i=$keep-1; $i -ge 1; $i--) { $from=$file -replace '\.log$', ('.' + $i + '.log'); $to=$file -replace '\.log$', ('.' + ($i+1) + '.log'); if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination $to -Force } }; Move-Item -LiteralPath $file -Destination ($file -replace '\.log$', '.1.log') -Force }" ^
  "if ($node -ne 'node' -and !(Test-Path -LiteralPath $node)) { throw ('Node.js not found: ' + $node) }" ^
  "if (!(Test-Path -LiteralPath $server)) { throw ('server.js not found in ' + $root) }" ^
  "$existingPid=$null;" ^
  "if (Test-Path -LiteralPath $pidFile) { $existingPid=Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1 }" ^
  "if ($existingPid -and ($existingPid -as [int])) { $existing=Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue; if ($existing) { try { $health=Invoke-WebRequest -UseBasicParsing -Uri ($url + '/api/config') -TimeoutSec 2; if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 500) { try { Start-Process $url } catch { Write-Host ('Browser open failed, please open manually: ' + $url) }; Write-Host ('Manager already running: ' + $url); exit 0 } } catch { Write-Host 'Stale pid file or manager port is not responding; restarting manager.' } } }" ^
  "if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }" ^
  "$listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "if ($listener) { throw ('Port ' + $port + ' is already in use by PID ' + $listener.OwningProcess + '. Close that process or set LLAMA_MANAGER_PORT to a free port.') }" ^
  "$out=Join-Path $root 'logs\manager.out.log';" ^
  "$err=Join-Path $root 'logs\manager.err.log';" ^
  "Rotate-Log $out 3; Rotate-Log $err 3;" ^
  "$process=Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru;" ^
  "Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII;" ^
  "$ready=$false; for ($i=0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if ($process.HasExited) { break }; try { $health=Invoke-WebRequest -UseBasicParsing -Uri ($url + '/api/config') -TimeoutSec 1; if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 500) { $ready=$true; break } } catch {} }" ^
  "if (!$ready) { if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Tail 40 }; throw 'Manager failed to become ready.' }" ^
  "try { Start-Process $url } catch { Write-Host ('Browser open failed, please open manually: ' + $url) }" ^
  "Write-Host ('Manager started: ' + $url)"

if errorlevel 1 (
  echo.
  echo Failed to start llama.cpp Manager.
  pause
  exit /b 1
)

echo llama.cpp Manager is available at %URL%

endlocal
