[CmdletBinding()]
param(
  [ValidateSet("start", "stop", "status")]
  [string]$Action = "start",

  [ValidateSet("local", "lan")]
  [string]$Mode = "local"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EntryRoot = Join-Path $Root "service-entry"
$EntryPort = if ($env:SERVICE_ENTRY_PORT) { [int]$env:SERVICE_ENTRY_PORT } else { 5176 }
$EntryHost = if ($env:SERVICE_ENTRY_HOST) {
  $env:SERVICE_ENTRY_HOST
} elseif ($Mode -eq "lan") {
  "0.0.0.0"
} else {
  "127.0.0.1"
}
$ProxyBaseUrl = if ($env:CLIPROXY_BASE_URL) { $env:CLIPROXY_BASE_URL } else { "http://127.0.0.1:8317" }
$ProxyUri = [Uri]$ProxyBaseUrl
$ProxyPort = $ProxyUri.Port
$ProxyProcessFile = Join-Path $EntryRoot ".cliproxy-process.json"
$EntryPidFile = Join-Path $EntryRoot ".manager.pid"
$script:ProxyStartedByLauncher = $false
$script:ProxyConfigPath = $null
$script:NodeExecutable = $null

function Get-PortListeners {
  param([int]$Port)
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortListener {
  param([int]$Port)
  Get-PortListeners -Port $Port | Select-Object -First 1
}

function Get-ListenerScope {
  param([int]$Port)
  $listeners = @(Get-PortListeners -Port $Port)
  if ($listeners.Count -eq 0) { return "offline" }
  $nonLoopback = @($listeners | Where-Object {
    $_.LocalAddress -notin @("127.0.0.1", "::1")
  })
  if ($nonLoopback.Count -gt 0) { return "lan" }
  return "local"
}

function Test-ListenerMatchesHost {
  param(
    [int]$Port,
    [string]$DesiredHost
  )
  $scope = Get-ListenerScope -Port $Port
  if ($DesiredHost -in @("127.0.0.1", "localhost", "::1")) {
    return $scope -eq "local"
  }
  return $scope -eq "lan"
}

function Assert-LoopbackListener {
  param(
    [int]$Port,
    [string]$Name
  )
  $listeners = @(Get-PortListeners -Port $Port)
  $scope = Get-ListenerScope -Port $Port
  if ($scope -ne "local") {
    $addresses = ($listeners | ForEach-Object { $_.LocalAddress }) -join ", "
    throw "$Name must listen only on 127.0.0.1 or ::1, but port $Port is '$scope' ($addresses). Restart it after correcting the config."
  }
}

function Wait-PortState {
  param(
    [int]$Port,
    [bool]$Open,
    [int]$TimeoutSeconds = 15
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $listening = [bool](Get-PortListener -Port $Port)
    if ($listening -eq $Open) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Resolve-Executable {
  param(
    [string]$EnvironmentValue,
    [string[]]$CommandNames,
    [string[]]$Candidates
  )
  if ($EnvironmentValue) {
    if (Test-Path -LiteralPath $EnvironmentValue -PathType Leaf) {
      return (Resolve-Path -LiteralPath $EnvironmentValue).Path
    }
    $explicitCommand = Get-Command $EnvironmentValue -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($explicitCommand) { return $explicitCommand.Source }
    throw "Executable configured in the environment was not found: $EnvironmentValue"
  }
  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  foreach ($commandName in $CommandNames) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  return $null
}

function Get-NodeExecutable {
  if ($script:NodeExecutable) { return $script:NodeExecutable }
  $script:NodeExecutable = Resolve-Executable `
    -EnvironmentValue $env:NODE_EXE `
    -CommandNames @("node.exe", "node") `
    -Candidates @()
  if (!$script:NodeExecutable) {
    throw "Node.js was not found. Install Node.js 20+ or set NODE_EXE."
  }
  $major = & $script:NodeExecutable -e "process.stdout.write(process.versions.node.split('.')[0])"
  if ([int]$major -lt 20) {
    throw "Node.js 20 or newer is required."
  }
  return $script:NodeExecutable
}

function Resolve-CliProxyConfig {
  param([string]$ProxyExecutable)
  if ($env:CLIPROXY_CONFIG) {
    if (!(Test-Path -LiteralPath $env:CLIPROXY_CONFIG -PathType Leaf)) {
      throw "CLIPROXY_CONFIG does not exist: $($env:CLIPROXY_CONFIG)"
    }
    return (Resolve-Path -LiteralPath $env:CLIPROXY_CONFIG).Path
  }
  $executableDirectory = if ($ProxyExecutable) { Split-Path -Parent $ProxyExecutable } else { "" }
  $candidates = @(
    (Join-Path $Root "config.yaml")
    (Join-Path $Root "config.yml")
    (Join-Path $Root "cliproxyapi.conf")
    if ($executableDirectory) { Join-Path $executableDirectory "config.yaml" }
    if ($executableDirectory) { Join-Path $executableDirectory "config.yml" }
    if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".cli-proxy-api\config.yaml" }
  ) | Where-Object { $_ }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Ensure-CliProxyLoopbackConfig {
  param([string]$ProxyExecutable)
  if ($ProxyUri.Host -notin @("127.0.0.1", "localhost", "::1")) { return }
  $script:ProxyConfigPath = Resolve-CliProxyConfig -ProxyExecutable $ProxyExecutable
  if (!$script:ProxyConfigPath) { return }
  $nodeExecutable = Get-NodeExecutable
  $tool = Join-Path $EntryRoot "subscription-config-tool.js"
  $resultText = & $nodeExecutable $tool ensure-loopback $script:ProxyConfigPath
  if ($LASTEXITCODE -ne 0) {
    throw "Could not enforce the CLIProxyAPI loopback setting in $($script:ProxyConfigPath)."
  }
  $result = $resultText | ConvertFrom-Json
  $env:CLIPROXY_CONFIG = $script:ProxyConfigPath
  if ($result.changed) {
    Write-Host "Updated CLIProxyAPI config to bind 127.0.0.1: $($script:ProxyConfigPath)"
  }
}

function Test-CliProxyApiEndpoint {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($ProxyBaseUrl.TrimEnd('/'))/v1/models" -TimeoutSec 3
    $status = [int]$response.StatusCode
    $headers = $response.Headers | Out-String
  } catch {
    $webResponse = $_.Exception.Response
    if (!$webResponse) { return $false }
    $status = [int]$webResponse.StatusCode
    $headers = $webResponse.Headers | Out-String
  }
  if ($status -notin @(200, 401, 403)) { return $false }
  return $headers -match "(?i)x-cpa-"
}

function Wait-CliProxyApi {
  param([int]$TimeoutSeconds = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-CliProxyApiEndpoint) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Resolve-LanAddress {
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -ne "127.0.0.1" -and
    $_.IPAddress -notlike "169.254*" -and
    $_.InterfaceAlias -notmatch "vEthernet|Docker|WSL|Loopback|Hyper-V|VirtualBox|VMware|OpenVPN|Surfshark|Tailscale|ZeroTier"
  }
  $preferred = $addresses | Where-Object { $_.IPAddress -like "192.168.*" } | Select-Object -First 1
  if ($preferred) { return $preferred.IPAddress }
  $preferred = $addresses | Where-Object { $_.IPAddress -like "10.*" } | Select-Object -First 1
  if ($preferred) { return $preferred.IPAddress }
  $preferred = $addresses | Select-Object -First 1
  if ($preferred) { return $preferred.IPAddress }
  return $null
}

function Start-CliProxyApi {
  $proxyExecutable = Resolve-Executable `
    -EnvironmentValue $env:CLIPROXY_EXE `
    -CommandNames @("cli-proxy-api.exe", "cli-proxy-api", "cliproxyapi.exe", "cliproxyapi") `
    -Candidates @(
      (Join-Path $Root "cli-proxy-api.exe"),
      (Join-Path $Root "CLIProxyAPI\cli-proxy-api.exe"),
      (Join-Path $Root "cliproxyapi.exe")
    )
  Ensure-CliProxyLoopbackConfig -ProxyExecutable $proxyExecutable

  if ($ProxyUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
    if (!(Test-CliProxyApiEndpoint)) {
      throw "Configured remote upstream did not present the CLIProxyAPI identity headers: $ProxyBaseUrl"
    }
    Write-Host "Using verified remote CLIProxyAPI upstream: $ProxyBaseUrl"
    return
  }
  if (Get-PortListener -Port $ProxyPort) {
    if (!(Test-CliProxyApiEndpoint)) {
      throw "Port $ProxyPort is occupied by a service that did not present the CLIProxyAPI identity headers."
    }
    Assert-LoopbackListener -Port $ProxyPort -Name "CLIProxyAPI"
    Write-Host "Verified CLIProxyAPI is already listening on loopback port $ProxyPort; it will be reused and not owned by this launcher."
    return
  }
  if (!$proxyExecutable) {
    throw "CLIProxyAPI executable was not found. Install it or set CLIPROXY_EXE, then run this launcher again. Setup guide: docs\subscription-proxy-guide.md"
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $proxyExecutable
  $startInfo.WorkingDirectory = Split-Path -Parent $proxyExecutable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  if ($script:ProxyConfigPath) {
    $safeConfig = $script:ProxyConfigPath.Replace('"', "")
    $startInfo.Arguments = '--config "' + $safeConfig + '"'
  }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()

  $record = [ordered]@{
    pid = $process.Id
    executable = $proxyExecutable
    startedAt = $process.StartTime.ToUniversalTime().ToString("o")
  }
  $record | ConvertTo-Json | Set-Content -LiteralPath $ProxyProcessFile -Encoding UTF8
  if (!(Wait-CliProxyApi -TimeoutSeconds 15)) {
    if (!$process.HasExited) { $process.Kill() }
    Remove-Item -LiteralPath $ProxyProcessFile -Force -ErrorAction SilentlyContinue
    throw "CLIProxyAPI did not become ready with a verifiable identity on port $ProxyPort within 15 seconds."
  }
  Assert-LoopbackListener -Port $ProxyPort -Name "CLIProxyAPI"
  $script:ProxyStartedByLauncher = $true
  Write-Host "Started CLIProxyAPI PID $($process.Id) on $ProxyBaseUrl"
}

function Start-SubscriptionEntry {
  $listener = Get-PortListener -Port $EntryPort
  if ($listener) {
    try {
      $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 3
    } catch {
      throw "Port $EntryPort is already in use and its service-entry mode could not be verified."
    }
    if ($status.entry.mode -ne "subscription") {
      throw "Port $EntryPort is running the full service-entry mode. Stop it before starting the isolated subscription stack."
    }
    if (Test-ListenerMatchesHost -Port $EntryPort -DesiredHost $EntryHost) {
      $scope = Get-ListenerScope -Port $EntryPort
      Write-Host "Subscription frontend and gateway are already running on $EntryPort in $scope mode."
      return
    }
    $recordedPid = if (Test-Path -LiteralPath $EntryPidFile -PathType Leaf) {
      [int](Get-Content -LiteralPath $EntryPidFile -Raw)
    } else {
      0
    }
    $processInfo = if ($recordedPid -gt 0) {
      Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
    } else {
      $null
    }
    $owned = $recordedPid -eq [int]$status.entry.pid -and
      $processInfo -and
      [string]$processInfo.CommandLine -match "(?i)node(?:\.exe)?.*server\.js"
    if (!$owned) {
      throw "Subscription service-entry has a different network binding and is not owned by this launcher. Stop it explicitly before switching modes."
    }
    $scope = if ($EntryHost -in @("127.0.0.1", "localhost", "::1")) { "local" } else { "lan" }
    Write-Host "Restarting the launcher-owned frontend/gateway to switch to $scope mode."
    Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$EntryPort/api/shutdown" -TimeoutSec 3 | Out-Null
    if (!(Wait-PortState -Port $EntryPort -Open $false -TimeoutSeconds 8)) {
      throw "The existing frontend/gateway did not stop for a network mode change."
    }
  }

  $nodeExecutable = Get-NodeExecutable

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeExecutable
  $startInfo.WorkingDirectory = $EntryRoot
  $startInfo.Arguments = "server.js"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["SERVICE_ENTRY_HOST"] = [string]$EntryHost
  $startInfo.EnvironmentVariables["SERVICE_ENTRY_PORT"] = [string]$EntryPort
  $startInfo.EnvironmentVariables["SERVICE_ENTRY_MODE"] = "subscription"
  $startInfo.EnvironmentVariables["CLIPROXY_ENABLED"] = "1"
  $startInfo.EnvironmentVariables["CLIPROXY_BASE_URL"] = [string]$ProxyBaseUrl
  if ($script:ProxyConfigPath) {
    $startInfo.EnvironmentVariables["CLIPROXY_CONFIG"] = [string]$script:ProxyConfigPath
  }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  Set-Content -LiteralPath $EntryPidFile -Value $process.Id -Encoding ASCII

  try {
    if (!(Wait-PortState -Port $EntryPort -Open $true -TimeoutSeconds 12)) {
      throw "Subscription frontend and gateway did not listen on port $EntryPort within 12 seconds."
    }
    $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 5
    if ($status.entry.mode -ne "subscription") {
      throw "service-entry started, but it did not enter subscription-only mode."
    }
    if (!(Test-ListenerMatchesHost -Port $EntryPort -DesiredHost $EntryHost)) {
      throw "Frontend/gateway listener does not match requested mode."
    }
  } catch {
    if (!$process.HasExited) { $process.Kill() }
    Remove-Item -LiteralPath $EntryPidFile -Force -ErrorAction SilentlyContinue
    throw
  }
  Write-Host "Started subscription frontend and gateway PID $($process.Id) on $EntryHost`:$EntryPort"
}

function Stop-OwnedCliProxyApi {
  if (!(Test-Path -LiteralPath $ProxyProcessFile -PathType Leaf)) {
    Write-Host "No launcher-owned CLIProxyAPI process was recorded; an independently started proxy is left running."
    return
  }
  try {
    $record = Get-Content -LiteralPath $ProxyProcessFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if (!$process) {
      Write-Host "The recorded CLIProxyAPI process is no longer running."
      Remove-Item -LiteralPath $ProxyProcessFile -Force
      return
    }
    $actualPath = $process.Path
    $actualStartedAt = $process.StartTime.ToUniversalTime()
    $recordedStartedAt = [DateTime]::Parse([string]$record.startedAt).ToUniversalTime()
    $samePath = $actualPath -and ([IO.Path]::GetFullPath($actualPath) -eq [IO.Path]::GetFullPath([string]$record.executable))
    $sameStart = [Math]::Abs(($actualStartedAt - $recordedStartedAt).TotalSeconds) -lt 2
    if (!$samePath -or !$sameStart) {
      throw "The recorded PID now belongs to a different process; it will not be stopped."
    }
    Stop-Process -Id $process.Id
    [void](Wait-PortState -Port $ProxyPort -Open $false -TimeoutSeconds 8)
    Remove-Item -LiteralPath $ProxyProcessFile -Force
    $script:ProxyStartedByLauncher = $false
    Write-Host "Stopped launcher-owned CLIProxyAPI PID $($process.Id)."
  } catch {
    Write-Warning $_.Exception.Message
  }
}

function Stop-SubscriptionStack {
  $listener = Get-PortListener -Port $EntryPort
  if ($listener) {
    try {
      $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 3
      if ($status.entry.mode -ne "subscription") {
        throw "Port $EntryPort is not running subscription-only mode; it will not be stopped by this script."
      }
      Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$EntryPort/api/shutdown" -TimeoutSec 3 | Out-Null
      [void](Wait-PortState -Port $EntryPort -Open $false -TimeoutSeconds 8)
      Remove-Item -LiteralPath $EntryPidFile -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped subscription frontend and gateway on $EntryPort."
    } catch {
      Write-Warning $_.Exception.Message
    }
  } else {
    Remove-Item -LiteralPath $EntryPidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Subscription frontend and gateway are already stopped."
  }
  Stop-OwnedCliProxyApi
}

function Show-SubscriptionStatus {
  $proxyListener = Get-PortListener -Port $ProxyPort
  $entryListener = Get-PortListener -Port $EntryPort
  $proxyScope = if ($ProxyUri.Host -in @("127.0.0.1", "localhost", "::1")) {
    Get-ListenerScope -Port $ProxyPort
  } else {
    "remote"
  }
  $entryScope = Get-ListenerScope -Port $EntryPort
  $entryMode = "offline"
  if ($entryListener) {
    try {
      $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 3
      $entryMode = [string]$status.entry.mode
    } catch {
      $entryMode = "listening, health failed"
    }
  }
  @(
    [pscustomobject]@{ Module = "CLIProxyAPI"; Port = $ProxyPort; Listening = [bool]$proxyListener; Bind = $proxyScope; Mode = "subscription upstream"; Url = $ProxyBaseUrl },
    [pscustomobject]@{ Module = "Frontend + Gateway"; Port = $EntryPort; Listening = [bool]$entryListener; Bind = $entryScope; Mode = $entryMode; Url = "http://127.0.0.1:$EntryPort/" }
  ) | Format-Table -AutoSize
}

switch ($Action) {
  "start" {
    try {
      Start-CliProxyApi
      Start-SubscriptionEntry
    } catch {
      if ($script:ProxyStartedByLauncher) { Stop-OwnedCliProxyApi }
      throw
    }
    Show-SubscriptionStatus
    Write-Host ""
    Write-Host "OpenAI:  http://127.0.0.1:$EntryPort/gateway/subscription/openai/v1"
    Write-Host "Claude:  http://127.0.0.1:$EntryPort/gateway/subscription/claude"
    Write-Host "Codex:   http://127.0.0.1:$EntryPort/gateway/subscription/codex/v1"
    Write-Host "OpenCode:http://127.0.0.1:$EntryPort/gateway/subscription/opencode/v1"
    if ((Get-ListenerScope -Port $EntryPort) -eq "lan") {
      $lanAddress = Resolve-LanAddress
      if ($lanAddress) {
        Write-Host ""
        Write-Host "LAN dashboard: http://$lanAddress`:$EntryPort/"
      }
    }
    if ($env:SUBSCRIPTION_PROXY_NO_OPEN -ne "1") {
      Start-Process "http://127.0.0.1:$EntryPort/subscription-console.html"
    }
  }
  "stop" {
    Stop-SubscriptionStack
  }
  "status" {
    Show-SubscriptionStatus
  }
}
