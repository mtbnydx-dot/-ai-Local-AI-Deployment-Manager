[CmdletBinding()]
param(
  [string]$AiRoot,
  [string]$NodeExe = "node",
  [int]$Port = 5190
)

$ErrorActionPreference = "Stop"

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside AI_ROOT: $fullPath"
  }
  return $fullPath
}

function Set-PrivateAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $systemSid = "S-1-5-18"
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  $grants = if (Test-Path -LiteralPath $Path -PathType Container) {
    @("*$($sid):(OI)(CI)F", "*$($systemSid):(OI)(CI)F")
  } else {
    @("*$($sid):F", "*$($systemSid):F")
  }
  & $icacls $Path /inheritance:r /grant:r $grants[0] $grants[1] | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to apply a private ACL to $Path" }
}

function New-ApiKey {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-ServerEnvironment {
  param([Parameter(Mandatory = $true)][string]$Path)

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction Stop) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^([A-Z0-9_]+)=(.*)$') { throw "Invalid line in MCP environment file." }
    $values[$matches[1]] = $matches[2]
  }
  return $values
}

function Wait-Health {
  param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutMs = 15000)

  $started = [DateTime]::UtcNow
  do {
    try {
      $response = Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 2
      if ($response.ok -eq $true -and $response.service -eq "local-ai-platform-mcp") { return $true }
    } catch {
      # The process can take a moment to bind after Node starts.
    }
    Start-Sleep -Milliseconds 300
  } while (([DateTime]::UtcNow - $started).TotalMilliseconds -lt $TimeoutMs)
  return $false
}

if ($Port -lt 1024 -or $Port -gt 65535) { throw "Port must be between 1024 and 65535." }
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($AiRoot)) {
  $AiRoot = if ([string]::IsNullOrWhiteSpace($env:AI_ROOT)) { $repositoryRoot } else { $env:AI_ROOT }
}
$root = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "AI_ROOT does not exist: $root" }

$platformRoot = Assert-ChildPath -Path (Join-Path $root "platform-mcp") -Parent $root
$entryPoint = Assert-ChildPath -Path (Join-Path $platformRoot "dist\src\index.js") -Parent $root
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  throw "Built MCP entry point is missing. Run install-all.cmd and platform-mcp npm run build first."
}

$runtimeRoot = Assert-ChildPath -Path (Join-Path $root ".runtime\platform-mcp") -Parent $root
$auditRoot = Assert-ChildPath -Path (Join-Path $root "audit-logs") -Parent $root
$secretPath = Assert-ChildPath -Path (Join-Path $runtimeRoot "server.env") -Parent $root
$pidPath = Assert-ChildPath -Path (Join-Path $runtimeRoot "server.pid") -Parent $root
$stdoutPath = Assert-ChildPath -Path (Join-Path $auditRoot "platform-mcp.stdout.log") -Parent $root
$stderrPath = Assert-ChildPath -Path (Join-Path $auditRoot "platform-mcp.stderr.log") -Parent $root
$auditPath = Assert-ChildPath -Path (Join-Path $auditRoot "platform-mcp.jsonl") -Parent $root
$searchKeyPath = Assert-ChildPath -Path (Join-Path $root "vllm-manager\logs\.last-public-service-key.txt") -Parent $root

New-Item -ItemType Directory -Force -Path $runtimeRoot, $auditRoot | Out-Null
Set-PrivateAcl -Path $runtimeRoot

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  if (Wait-Health -Url "http://127.0.0.1:$Port/health" -TimeoutMs 2500) {
    Write-Host "Platform MCP is already healthy on 127.0.0.1:$Port (PID $($listener.OwningProcess))."
    exit 0
  }
  throw "Port $Port is already owned by PID $($listener.OwningProcess), but it is not a healthy Platform MCP service."
}

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
  $apiKey = New-ApiKey
  @(
    "# Generated locally. Do not share or commit this file.",
    "PLATFORM_MCP_API_KEY=$apiKey"
  ) | Set-Content -LiteralPath $secretPath -Encoding ASCII
  Set-PrivateAcl -Path $secretPath
}
$serverEnvironment = Read-ServerEnvironment -Path $secretPath
$apiKey = [string]$serverEnvironment["PLATFORM_MCP_API_KEY"]
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 32) {
  throw "The Platform MCP API key file is invalid."
}
$searchGatewayApiKey = [string]$env:PLATFORM_MCP_SEARCH_GATEWAY_API_KEY
if ([string]::IsNullOrWhiteSpace($searchGatewayApiKey) -and (Test-Path -LiteralPath $searchKeyPath -PathType Leaf)) {
  $searchGatewayApiKey = (Get-Content -LiteralPath $searchKeyPath -Raw -ErrorAction Stop).Trim()
}
if (-not [string]::IsNullOrWhiteSpace($searchGatewayApiKey) -and $searchGatewayApiKey.Length -lt 16) {
  throw "The configured search-gateway API key is too short."
}

$environmentNames = @(
  "AI_ROOT", "PLATFORM_MCP_HOST", "PLATFORM_MCP_PORT", "PLATFORM_MCP_API_KEY",
  "PLATFORM_MCP_SERVICE_ENTRY_URL", "PLATFORM_MCP_VLLM_MANAGER_URL",
  "PLATFORM_MCP_LLAMA_MANAGER_URL", "PLATFORM_MCP_SEARCH_GATEWAY_URL",
  "PLATFORM_MCP_SEARCH_GATEWAY_API_KEY", "PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE",
  "PLATFORM_MCP_AUDIT_LOG", "PLATFORM_MCP_ALLOWED_HOSTS"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

try {
  $env:AI_ROOT = $root
  $env:PLATFORM_MCP_HOST = "127.0.0.1"
  $env:PLATFORM_MCP_PORT = [string]$Port
  $env:PLATFORM_MCP_API_KEY = $apiKey
  $env:PLATFORM_MCP_SERVICE_ENTRY_URL = "http://127.0.0.1:5176"
  $env:PLATFORM_MCP_VLLM_MANAGER_URL = "http://127.0.0.1:5177"
  $env:PLATFORM_MCP_LLAMA_MANAGER_URL = "http://127.0.0.1:5178"
  $env:PLATFORM_MCP_SEARCH_GATEWAY_URL = "http://127.0.0.1:5180"
  $env:PLATFORM_MCP_SEARCH_GATEWAY_API_KEY = $searchGatewayApiKey
  if ([string]::IsNullOrWhiteSpace($env:PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE)) {
    $env:PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE = "20"
  }
  $env:PLATFORM_MCP_AUDIT_LOG = $auditPath
  $env:PLATFORM_MCP_ALLOWED_HOSTS = "127.0.0.1,localhost,::1,host.docker.internal"
  $process = Start-Process -FilePath $NodeExe -ArgumentList @($entryPoint) -WorkingDirectory $platformRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}

Set-Content -LiteralPath $pidPath -Value ([string]$process.Id) -Encoding ASCII
Set-PrivateAcl -Path $pidPath
if (-not (Wait-Health -Url "http://127.0.0.1:$Port/health" -TimeoutMs 15000)) {
  if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $process.Id -Force }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  throw "Platform MCP did not become healthy. See $stderrPath"
}

$bound = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $process.Id }
if (-not $bound -or ($bound | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  throw "Platform MCP did not bind exclusively to loopback."
}

Write-Host "Platform MCP started: http://127.0.0.1:$Port/mcp"
Write-Host "PID: $($process.Id)"
Write-Host "Bearer key is stored privately at: $secretPath"
Write-Host ("Web search tool: " + $(if ([string]::IsNullOrWhiteSpace($searchGatewayApiKey)) { "disabled (search key unavailable)" } else { "enabled" }))
Write-Host "No model or manager process was restarted."
