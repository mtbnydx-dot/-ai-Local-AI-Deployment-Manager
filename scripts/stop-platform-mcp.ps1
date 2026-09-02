[CmdletBinding()]
param(
  [string]$AiRoot,
  [int]$Port = 5190
)

$ErrorActionPreference = "Stop"

function Assert-ChildPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Parent)
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside AI_ROOT: $fullPath"
  }
  return $fullPath
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($AiRoot)) {
  $AiRoot = if ([string]::IsNullOrWhiteSpace($env:AI_ROOT)) { $repositoryRoot } else { $env:AI_ROOT }
}
$root = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\')
$pidPath = Assert-ChildPath -Path (Join-Path $root ".runtime\platform-mcp\server.pid") -Parent $root
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$pidValue = 0
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$pidValue)
}
if ($pidValue -le 0 -and $listener) { $pidValue = [int]$listener.OwningProcess }
if ($pidValue -le 0) {
  Write-Host "Platform MCP is already stopped."
  exit 0
}

$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
if (-not $processInfo) {
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  Write-Host "Platform MCP process is absent; removed its stale PID file."
  exit 0
}
$commandLine = [string]$processInfo.CommandLine
$healthIdentifiesService = $false
if ($listener -and [int]$listener.OwningProcess -eq $pidValue) {
  try {
    $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    $healthIdentifiesService = $health.ok -eq $true -and $health.service -eq "local-ai-platform-mcp"
  } catch {
    $healthIdentifiesService = $false
  }
}
$commandMatches = $commandLine -match '(?i)dist[\\/]src[\\/]index\.js' -and (
  $commandLine -match '(?i)platform-mcp' -or $healthIdentifiesService
)
if (-not $commandMatches) {
  throw "Refusing to stop PID $pidValue because it is not the Platform MCP command."
}
if ($listener -and [int]$listener.OwningProcess -ne $pidValue) {
  throw "Refusing to stop PID $pidValue because port $Port belongs to PID $($listener.OwningProcess)."
}

Stop-Process -Id $pidValue
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
  throw "Platform MCP did not stop within six seconds."
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host "Platform MCP stopped. vLLM, llama.cpp, and their model containers were not changed."
