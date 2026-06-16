@echo off
setlocal
set "ROOT=%~dp0"
set "ENTRY_HOST=127.0.0.1"
if /I "%~1"=="lan" set "ENTRY_HOST=0.0.0.0"
if defined SERVICE_ENTRY_HOST set "ENTRY_HOST=%SERVICE_ENTRY_HOST%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root=$env:ROOT;" ^
  "$entryHost=$env:ENTRY_HOST; if ([string]::IsNullOrWhiteSpace($entryHost)) { $entryHost='127.0.0.1' }" ^
  "$node=$env:NODE_EXE; if ([string]::IsNullOrWhiteSpace($node)) { $node='node' }" ^
  "$items=@(" ^
  "  @{Name='vLLM Manager'; Root=(Join-Path $root 'vllm-manager'); Port=5177; EnvPort='VLLM_MANAGER_PORT'; EnvHost='VLLM_MANAGER_HOST'; Host='0.0.0.0'}," ^
  "  @{Name='llama.cpp Manager'; Root=(Join-Path $root 'llama-manager'); Port=5178; EnvPort='LLAMA_MANAGER_PORT'; EnvHost='LLAMA_MANAGER_HOST'; Host='0.0.0.0'}," ^
  "  @{Name='Service Entry'; Root=(Join-Path $root 'service-entry'); Port=5176; EnvPort='SERVICE_ENTRY_PORT'; EnvHost='SERVICE_ENTRY_HOST'; Host=$entryHost}" ^
  ");" ^
  "function Wait-HttpReady($url, [int]$timeoutMs) { $start=Get-Date; while (((Get-Date)-$start).TotalMilliseconds -lt $timeoutMs) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true } } catch {}; Start-Sleep -Milliseconds 400 }; return $false }" ^
  "foreach ($item in $items) {" ^
  "  $listener=Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "  if ($listener) { Write-Host ($item.Name + ' already running on ' + $item.Port); $healthPath='/api/manager/health'; if ($item.Name -eq 'Service Entry') { $healthPath='/api/status' }; $ready=Wait-HttpReady ('http://127.0.0.1:' + $item.Port + $healthPath) 5000; if (!$ready) { Write-Warning ($item.Name + ' port is listening but health check did not pass yet.') }; continue }" ^
  "  $psi=New-Object System.Diagnostics.ProcessStartInfo;" ^
  "  $psi.FileName=$node; $psi.WorkingDirectory=$item.Root; $psi.Arguments='server.js';" ^
  "  $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true;" ^
  "  $psi.Environment[$item.EnvPort]=[string]$item.Port; $psi.Environment[$item.EnvHost]=[string]$item.Host;" ^
  "  if ($item.Name -eq 'vLLM Manager') { $psi.Environment['VLLM_MANAGER_ALLOW_REMOTE']='0' }" ^
  "  if ($item.Name -eq 'llama.cpp Manager') { $psi.Environment['LLAMA_MANAGER_ALLOW_REMOTE']='0' }" ^
  "  $proc=New-Object System.Diagnostics.Process; $proc.StartInfo=$psi; [void]$proc.Start();" ^
  "  Set-Content -LiteralPath (Join-Path $item.Root '.manager.pid') -Value $proc.Id -Encoding ASCII;" ^
  "  Write-Host ('Started ' + $item.Name + ' PID ' + $proc.Id + ' on ' + $item.Port + ' host ' + $item.Host);" ^
  "  $healthPath='/api/manager/health'; if ($item.Name -eq 'Service Entry') { $healthPath='/api/status' }; $ready=Wait-HttpReady ('http://127.0.0.1:' + $item.Port + $healthPath) 12000;" ^
  "  if ($ready) { Write-Host ($item.Name + ' health check passed.') } else { Write-Warning ($item.Name + ' did not become healthy within 12 seconds. Check logs in ' + $item.Root + '\logs') }" ^
  "}" ^
  "function Resolve-LanAddress { $ips=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' -and $_.InterfaceAlias -notmatch 'vEthernet|Docker|WSL|Loopback|Hyper-V|VirtualBox|VMware|OpenVPN|Surfshark|Tailscale|ZeroTier' }; $preferred=$ips | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; $route=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; if ($route) { $ip=Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1; if ($ip) { return $ip.IPAddress } }; $preferred=$ips | Where-Object { $_.IPAddress -like '10.*' } | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; $preferred=$ips | Select-Object -First 1; if ($preferred) { return $preferred.IPAddress }; return $null }" ^
  "$lan=Resolve-LanAddress;" ^
  "Write-Host '';" ^
  "Write-Host 'Service Entry local:  http://127.0.0.1:5176/';" ^
  "Write-Host 'Auto OpenAI local:    http://127.0.0.1:5176/gateway/auto/openai/v1';" ^
  "Write-Host 'Auto Claude local:    http://127.0.0.1:5176/gateway/auto/claude';" ^
  "Write-Host 'Auto OpenCode local:  http://127.0.0.1:5176/gateway/auto/opencode/v1';" ^
  "if ($entryHost -ne '127.0.0.1' -and $lan) {" ^
  "  Write-Host ''; Write-Host ('Service Entry LAN:    http://' + $lan + ':5176/');" ^
  "  Write-Host ('Auto OpenAI LAN:      http://' + $lan + ':5176/gateway/auto/openai/v1');" ^
  "  Write-Host ('Auto Claude LAN:      http://' + $lan + ':5176/gateway/auto/claude');" ^
  "  Write-Host ('Auto OpenCode LAN:    http://' + $lan + ':5176/gateway/auto/opencode/v1');" ^
  "} elseif ($entryHost -eq '127.0.0.1') { Write-Host ''; Write-Host 'LAN mode is off. Run: start-service-entry.cmd lan' }" ^
  "Start-Process 'http://127.0.0.1:5176/'"

endlocal
