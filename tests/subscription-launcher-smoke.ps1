[CmdletBinding()]
param(
  [string]$Launcher = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (!$Launcher) { $Launcher = Join-Path $Root "subscription-proxy-stack.ps1" }
if (![IO.Path]::IsPathRooted($Launcher)) { $Launcher = Join-Path $Root $Launcher }
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("subscription-launcher-" + [Guid]::NewGuid().ToString("N"))
$ProxyPort = if ($env:SUBSCRIPTION_TEST_PROXY_PORT) { [int]$env:SUBSCRIPTION_TEST_PROXY_PORT } else { 18327 }
$EntryPort = if ($env:SUBSCRIPTION_TEST_ENTRY_PORT) { [int]$env:SUBSCRIPTION_TEST_ENTRY_PORT } else { 15186 }
$MockProcess = $null

function Start-MockProxy {
  param(
    [bool]$IdentityHeaders = $true,
    [string]$ListenHost = "127.0.0.1"
  )
  $previousIdentity = $env:CLIPROXY_IDENTITY_HEADERS
  $previousHost = $env:CLIPROXY_LISTEN_HOST
  try {
    $env:CLIPROXY_IDENTITY_HEADERS = if ($IdentityHeaders) { "1" } else { "0" }
    $env:CLIPROXY_LISTEN_HOST = $ListenHost
    return Start-Process node `
      -ArgumentList (Join-Path $Root "tests\mock-cliproxy-api.cjs") `
      -WorkingDirectory $Root `
      -NoNewWindow `
      -PassThru
  } finally {
    $env:CLIPROXY_IDENTITY_HEADERS = $previousIdentity
    $env:CLIPROXY_LISTEN_HOST = $previousHost
  }
}

function Stop-MockProxy {
  if ($script:MockProcess -and !$script:MockProcess.HasExited) {
    Stop-Process -Id $script:MockProcess.Id -Force
    $script:MockProcess.WaitForExit()
  }
  $script:MockProcess = $null
}

function Assert-EntryHost {
  param([string]$Expected)
  $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$EntryPort/api/status" -TimeoutSec 5
  if ($status.entry.mode -ne "subscription" -or $status.entry.host -ne $Expected) {
    throw "Expected subscription entry host '$Expected', got '$($status.entry.host)'."
  }
}

New-Item -ItemType Directory -Path $TempDir | Out-Null
$ConfigPath = Join-Path $TempDir "config.yaml"
@"
host: ""
port: $ProxyPort
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "launcher-smoke-key-that-is-long-enough"
"@ | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

$env:CLIPROXY_BASE_URL = "http://127.0.0.1:$ProxyPort"
$env:SERVICE_ENTRY_PORT = [string]$EntryPort
$env:SUBSCRIPTION_PROXY_NO_OPEN = "1"
$env:CLIPROXY_EXE = $null
$env:SERVICE_ENTRY_HOST = $null

try {
  $MockProcess = Start-MockProxy
  Push-Location $TempDir
  try {
    $env:CLIPROXY_CONFIG = "config.yaml"
    & $Launcher start local
  } finally {
    Pop-Location
  }
  if ((Get-Content -LiteralPath $ConfigPath -Raw) -notmatch '(?m)^host: "127\.0\.0\.1"\r?$') {
    throw "The launcher did not correct the CLIProxyAPI host setting."
  }
  Assert-EntryHost -Expected "127.0.0.1"

  $env:CLIPROXY_CONFIG = $ConfigPath
  & $Launcher start lan
  Assert-EntryHost -Expected "0.0.0.0"
  & $Launcher start local
  Assert-EntryHost -Expected "127.0.0.1"
  & $Launcher stop
  if ($MockProcess.HasExited) { throw "The launcher stopped an independently started CLIProxyAPI mock." }
  Stop-MockProxy

  $MockProcess = Start-MockProxy -IdentityHeaders $false
  $rejected = $false
  try {
    & $Launcher start local
  } catch {
    $rejected = $_.Exception.Message -match "did not present the CLIProxyAPI identity headers"
  }
  if (!$rejected) { throw "The launcher accepted a service without CLIProxyAPI identity headers." }
  Stop-MockProxy

  $MockProcess = Start-MockProxy -ListenHost "0.0.0.0"
  $rejected = $false
  try {
    & $Launcher start local
  } catch {
    $rejected = $_.Exception.Message -match "must listen only on 127.0.0.1 or ::1"
  }
  if (!$rejected) { throw "The launcher accepted a wildcard CLIProxyAPI listener." }

  Write-Host "Windows subscription launcher smoke checks passed."
} finally {
  try { & $Launcher stop } catch {}
  Stop-MockProxy
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
