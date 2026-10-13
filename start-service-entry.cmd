@echo off
setlocal
rem Set SERVICE_ENTRY_NO_BROWSER=1 for unattended/headless startup.
rem Each process writes stdout/stderr to <component>\logs\manager.out.log and
rem manager.err.log; the previous run's files are kept as .1 / .2 / .3.
rem SERVICE_ENTRY_PORT, VLLM_MANAGER_PORT and LLAMA_MANAGER_PORT override the
rem default ports 5176-5178. The script exits 1, and opens no browser, when
rem Node.js is unsupported or any component fails its health check (the entry
rem is checked through GET /gateway/health).
set "ROOT=%~dp0"
set "ENTRY_HOST=127.0.0.1"
if /I "%~1"=="lan" set "ENTRY_HOST=0.0.0.0"
if defined SERVICE_ENTRY_HOST set "ENTRY_HOST=%SERVICE_ENTRY_HOST%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root=$env:ROOT;" ^
  "$entryHost=$env:ENTRY_HOST; if ([string]::IsNullOrWhiteSpace($entryHost)) { $entryHost='127.0.0.1' }" ^
  "$node=$env:NODE_EXE; if ([string]::IsNullOrWhiteSpace($node)) { $node='node' }" ^
  "$nodeVersion=''; try { $nodeVersion=[string](& $node -v 2>$null | Select-Object -First 1) } catch {}" ^
  "if (!($nodeVersion -match '^v(\d+)\.(\d+)\.(\d+)')) { Write-Host ('Node.js was not found or did not report a version: ' + $node + '. Install Node.js ^22.22.2, ^24.15.0 or 26+, or set NODE_EXE.'); exit 1 }" ^
  "$major=[int]$Matches[1]; $minor=[int]$Matches[2]; $patch=[int]$Matches[3];" ^
  "if (!(($major -ge 26) -or ($major -eq 24 -and $minor -ge 15) -or ($major -eq 22 -and ($minor -gt 22 -or ($minor -eq 22 -and $patch -ge 2))))) { Write-Host ('Node.js ' + $nodeVersion + ' is not supported. The platform needs ^22.22.2, ^24.15.0 or 26+; install a supported version or set NODE_EXE.'); exit 1 }" ^
  "function Get-PortSetting($name, [int]$default) { $raw=[Environment]::GetEnvironmentVariable($name, 'Process'); if ([string]::IsNullOrWhiteSpace($raw)) { return $default }; $value=$raw -as [int]; if (!$value -or $value -lt 1 -or $value -gt 65535) { throw ($name + ' must be a port number between 1 and 65535: ' + $raw) }; return $value }" ^
  "$entryPort=Get-PortSetting 'SERVICE_ENTRY_PORT' 5176;" ^
  "$items=@(" ^
  "  @{Name='vLLM Manager'; Root=(Join-Path $root 'vllm-manager'); Port=(Get-PortSetting 'VLLM_MANAGER_PORT' 5177); EnvPort='VLLM_MANAGER_PORT'; EnvHost='VLLM_MANAGER_HOST'; Host='0.0.0.0'; Health='/api/manager/health'; Extra=@{VLLM_MANAGER_ALLOW_REMOTE='0'}}," ^
  "  @{Name='llama.cpp Manager'; Root=(Join-Path $root 'llama-manager'); Port=(Get-PortSetting 'LLAMA_MANAGER_PORT' 5178); EnvPort='LLAMA_MANAGER_PORT'; EnvHost='LLAMA_MANAGER_HOST'; Host='0.0.0.0'; Health='/api/manager/health'; Extra=@{LLAMA_MANAGER_ALLOW_REMOTE='0'}}," ^
  "  @{Name='Service Entry'; Root=(Join-Path $root 'service-entry'); Port=$entryPort; EnvPort='SERVICE_ENTRY_PORT'; EnvHost='SERVICE_ENTRY_HOST'; Host=$entryHost; Health='/gateway/health'; Extra=@{}}" ^
  ");" ^
  "function Wait-HttpReady($url, [int]$timeoutMs) { $start=Get-Date; while (((Get-Date)-$start).TotalMilliseconds -lt $timeoutMs) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true } } catch {}; Start-Sleep -Milliseconds 400 }; return $false }" ^
  "function Rotate-Log($file, [int]$keep) { if (!(Test-Path -LiteralPath $file)) { return }; for ($i=$keep-1; $i -ge 1; $i--) { $from=$file -replace '\.log$', ('.' + $i + '.log'); $to=$file -replace '\.log$', ('.' + ($i+1) + '.log'); if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination $to -Force } }; Move-Item -LiteralPath $file -Destination ($file -replace '\.log$', '.1.log') -Force }" ^
  "$failed=@();" ^
  "foreach ($item in $items) {" ^
  "  $healthUrl='http://127.0.0.1:' + $item.Port + $item.Health;" ^
  "  $listener=Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "  if ($listener) { Write-Host ($item.Name + ' already running on ' + $item.Port); if (!(Wait-HttpReady $healthUrl 5000)) { Write-Warning ($item.Name + ' port ' + $item.Port + ' is listening but ' + $healthUrl + ' did not answer 2xx.'); $failed+=$item.Name }; continue }" ^
  "  $logs=Join-Path $item.Root 'logs'; if (!(Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }" ^
  "  $out=Join-Path $logs 'manager.out.log'; $err=Join-Path $logs 'manager.err.log'; Rotate-Log $out 3; Rotate-Log $err 3;" ^
  "  $saved=@{}; $vars=@{}; $vars[$item.EnvPort]=[string]$item.Port; $vars[$item.EnvHost]=[string]$item.Host; foreach ($k in $item.Extra.Keys) { $vars[$k]=$item.Extra[$k] }" ^
  "  foreach ($k in $vars.Keys) { $saved[$k]=[Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }" ^
  "  try { $proc=Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $item.Root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru } finally { foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }" ^
  "  Set-Content -LiteralPath (Join-Path $item.Root '.manager.pid') -Value $proc.Id -Encoding ASCII;" ^
  "  Write-Host ('Started ' + $item.Name + ' PID ' + $proc.Id + ' on ' + $item.Port + ' host ' + $item.Host + ' (log: ' + $out + ')');" ^
  "  if (Wait-HttpReady $healthUrl 12000) { Write-Host ($item.Name + ' health check passed.') } else { Write-Warning ($item.Name + ' did not become healthy within 12 seconds (' + $healthUrl + '). Check ' + $err); $failed+=$item.Name }" ^
  "}" ^
  "function Resolve-LanAddress { $ips=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' -and $_.InterfaceAlias -notmatch 'vEthernet|Docker|WSL|Loopback|Hyper-V|VirtualBox|VMware|OpenVPN|Surfshark|Tailscale|ZeroTier' }; $preferred=$ips | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; $route=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; if ($route) { $ip=Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1; if ($ip) { return $ip.IPAddress } }; $preferred=$ips | Where-Object { $_.IPAddress -like '10.*' } | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; $preferred=$ips | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; return $null }" ^
  "$lan=Resolve-LanAddress;" ^
  "$local='http://127.0.0.1:' + $entryPort;" ^
  "Write-Host '';" ^
  "Write-Host ('Service Entry local:  ' + $local + '/');" ^
  "Write-Host ('Billing Center local: ' + $local + '/billing');" ^
  "Write-Host ('Auto OpenAI local:    ' + $local + '/gateway/auto/openai/v1');" ^
  "Write-Host ('Auto Claude local:    ' + $local + '/gateway/auto/claude');" ^
  "Write-Host ('Auto OpenCode local:  ' + $local + '/gateway/auto/opencode/v1');" ^
  "Write-Host ('Gateway status:       ' + $local + '/gateway/status');" ^
  "if ($entryHost -ne '127.0.0.1' -and $lan) {" ^
  "  $remote='http://' + $lan + ':' + $entryPort;" ^
  "  Write-Host ''; Write-Host ('Service Entry LAN:    ' + $remote + '/');" ^
  "  Write-Host ('Auto OpenAI LAN:      ' + $remote + '/gateway/auto/openai/v1');" ^
  "  Write-Host ('Auto Claude LAN:      ' + $remote + '/gateway/auto/claude');" ^
  "  Write-Host ('Auto OpenCode LAN:    ' + $remote + '/gateway/auto/opencode/v1');" ^
  "} elseif ($entryHost -eq '127.0.0.1') { Write-Host ''; Write-Host 'LAN mode is off. Run: start-service-entry.cmd lan' }" ^
  "if ($failed.Count) { Write-Host ''; Write-Host ('Not healthy: ' + ($failed -join ', ') + '. The browser was not opened; see the logs folder of each component.'); exit 1 }" ^
  "if ($env:SERVICE_ENTRY_NO_BROWSER -ne '1') { Write-Host ('Opening ' + $local + '/'); Start-Process ($local + '/') }"
set "CODE=%ERRORLEVEL%"

endlocal & exit /b %CODE%
