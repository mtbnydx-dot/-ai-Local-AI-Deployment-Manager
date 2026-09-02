[CmdletBinding()]
param(
  [string]$AiRoot,
  [int]$Port = 5190,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($AiRoot)) {
  $AiRoot = if ([string]::IsNullOrWhiteSpace($env:AI_ROOT)) { $repositoryRoot } else { $env:AI_ROOT }
}
$root = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\')
$pidPath = Join-Path $root ".runtime\platform-mcp\server.pid"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$health = $null
if ($listener) {
  try { $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 } catch { $health = $null }
}
$pidFilePid = $null
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  $parsedPid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$parsedPid)) { $pidFilePid = $parsedPid }
}
$serviceHealthy = [bool]($listener -and $health -and $health.ok -eq $true -and $health.service -eq "local-ai-platform-mcp")
$status = [ordered]@{
  ok = $serviceHealthy
  listening = [bool]$listener
  health = if ($serviceHealthy) { "healthy" } elseif ($listener) { "unhealthy" } else { "offline" }
  host = "127.0.0.1"
  port = $Port
  pid = if ($listener) { [int]$listener.OwningProcess } else { $pidFilePid }
  pidFileMatches = [bool]($listener -and $pidFilePid -and [int]$listener.OwningProcess -eq $pidFilePid)
  endpoint = "http://127.0.0.1:$Port/mcp"
  readOnly = $true
  authRequired = if ($health) { [bool]$health.auth_required } else { $true }
}
if ($Json) {
  $status | ConvertTo-Json -Compress
} else {
  [pscustomobject]$status | Format-List
}
