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

function Get-PortListener {
  param([int]$Port)
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
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
  if ($ProxyUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
    Write-Host "Using configured remote CLIProxyAPI upstream: $ProxyBaseUrl"
    return
  }
  if (Get-PortListener -Port $ProxyPort) {
    Write-Host "CLIProxyAPI is already listening on $ProxyPort; it will be reused and not owned by this launcher."
    return
  }
  $proxyExecutable = Resolve-Executable `
    -EnvironmentValue $env:CLIPROXY_EXE `
    -CommandNames @("cli-proxy-api.exe", "cli-proxy-api", "cliproxyapi.exe", "cliproxyapi") `
    -Candidates @(
      (Join-Path $Root "cli-proxy-api.exe"),
      (Join-Path $Root "CLIProxyAPI\cli-proxy-api.exe"),
      (Join-Path $Root "cliproxyapi.exe")
    )
  if (!$proxyExecutable) {
    throw "CLIProxyAPI executable was not found. Install it or set CLIPROXY_EXE, then run this launcher again. Setup guide: docs\subscription-proxy-guide.md"
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $proxyExecutable
  $startInfo.WorkingDirectory = Split-Path -Parent $proxyExecutable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  if ($env:CLIPROXY_CONFIG) {
    $safeConfig = $env:CLIPROXY_CONFIG.Replace('"', "")
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
  if (!(Wait-PortState -Port $ProxyPort -Open $true -TimeoutSeconds 15)) {
    if (!$process.HasExited) { $process.Kill() }
    Remove-Item -LiteralPath $ProxyProcessFile -Force -ErrorAction SilentlyContinue
    throw "CLIProxyAPI did not listen on port $ProxyPort within 15 seconds. Check its config file and API-key settings."
  }
  $script:ProxyStartedByLauncher = $true
  Write-Host "Started CLIProxyAPI PID $($process.Id) on $ProxyBaseUrl"
}

function Start-SubscriptionEntry {
  $listener = Get-PortListener -Port $EntryPort
  if ($listener) {
    try {
      $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 3
      if ($status.entry.mode -eq "subscription") {
        Write-Host "Subscription frontend and gateway are already running on $EntryPort."
        return
      }
    } catch {
      throw "Port $EntryPort is already in use and its service-entry mode could not be verified."
    }
    throw "Port $EntryPort is running the full service-entry mode. Stop it before starting the isolated subscription stack."
  }

  $nodeExecutable = Resolve-Executable `
    -EnvironmentValue $env:NODE_EXE `
    -CommandNames @("node.exe", "node") `
    -Candidates @()
  if (!$nodeExecutable) { throw "Node.js was not found. Install Node.js 20+ or set NODE_EXE." }

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
    [pscustomobject]@{ Module = "CLIProxyAPI"; Port = $ProxyPort; Listening = [bool]$proxyListener; Mode = "subscription upstream"; Url = $ProxyBaseUrl },
    [pscustomobject]@{ Module = "Frontend + Gateway"; Port = $EntryPort; Listening = [bool]$entryListener; Mode = $entryMode; Url = "http://127.0.0.1:$EntryPort/" }
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
    if ($EntryHost -ne "127.0.0.1") {
      $lanAddress = Resolve-LanAddress
      if ($lanAddress) {
        Write-Host ""
        Write-Host "LAN dashboard: http://$lanAddress`:$EntryPort/"
      }
    }
    Start-Process "http://127.0.0.1:$EntryPort/subscription-console.html"
  }
  "stop" {
    Stop-SubscriptionStack
  }
  "status" {
    Show-SubscriptionStatus
  }
}
