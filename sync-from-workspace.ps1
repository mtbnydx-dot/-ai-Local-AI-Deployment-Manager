$ErrorActionPreference = "Stop"

$releaseRoot = (Resolve-Path $PSScriptRoot).Path
$workspaceRoot = (Resolve-Path (Join-Path $releaseRoot "..")).Path

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside release directory: $fullPath"
  }
}

function Test-ExcludedFileName {
  param([Parameter(Mandatory = $true)][string]$Name)
  foreach ($pattern in $excludeFiles) {
    if ($Name -like $pattern) { return $true }
  }
  return $false
}

$directories = @(
  ".github",
  "docs",
  "manager-core",
  "service-entry",
  "vllm-manager",
  "llama-manager",
  "model-capability-tests",
  "vllm"
)

$files = @(
  ".gitignore",
  "README.md",
  "SYNC_POLICY.md",
  "install-all.cmd",
  "test-all.cmd",
  "start-service-entry.cmd",
  "start-service-entry-lan.cmd",
  "stop-service-entry.cmd",
  "start-claude-vllm-proxy.ps1",
  "claude-vllm-anthropic-proxy.py",
  "repair-windows-admin.ps1"
)

$excludeDirs = @(
  "node_modules",
  ".git",
  "logs",
  "__pycache__",
  ".cache",
  "cache",
  "models",
  "audit-logs",
  "openwebui-exports",
  "venvs",
  "projects"
)

$excludeFiles = @(
  ".manager.pid",
  "*.log",
  "*.pid",
  "*.tmp",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  "*.local.json",
  "*.secret.json",
  "stats-ledger.json",
  "jobs-ledger.json",
  "service-exposure.json",
  "service-api-key.json",
  ".env",
  ".env.*"
)

foreach ($dir in $directories) {
  $source = Join-Path $workspaceRoot $dir
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    Write-Warning "Skipping missing directory: $dir"
    continue
  }

  $target = Join-Path $releaseRoot $dir
  Assert-ChildPath -Path $target -Parent $releaseRoot
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  $args = @(
    $source,
    $target,
    "/MIR",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD"
  ) + $excludeDirs + @("/XF") + $excludeFiles

  & robocopy @args | Out-Null
  $code = $LASTEXITCODE
  if ($code -gt 7) {
    throw "robocopy failed for $dir with exit code $code"
  }
}

foreach ($file in $files) {
  $source = Join-Path $workspaceRoot $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    Write-Warning "Skipping missing file: $file"
    continue
  }

  $target = Join-Path $releaseRoot $file
  Assert-ChildPath -Path $target -Parent $releaseRoot
  Copy-Item -LiteralPath $source -Destination $target -Force
}

foreach ($dir in $directories) {
  $targetDir = Join-Path $releaseRoot $dir
  if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) { continue }
  foreach ($excluded in $excludeDirs) {
    $excludedPath = Join-Path $targetDir $excluded
    if (-not (Test-Path -LiteralPath $excludedPath)) { continue }
    Assert-ChildPath -Path $excludedPath -Parent $releaseRoot
    Remove-Item -LiteralPath $excludedPath -Recurse -Force
  }
}

foreach ($excluded in ($excludeDirs | Where-Object { $_ -ne ".git" })) {
  $excludedPath = Join-Path $releaseRoot $excluded
  if (-not (Test-Path -LiteralPath $excludedPath)) { continue }
  Assert-ChildPath -Path $excludedPath -Parent $releaseRoot
  Remove-Item -LiteralPath $excludedPath -Recurse -Force
}

Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
  Test-ExcludedFileName -Name $_.Name
} | ForEach-Object {
  Assert-ChildPath -Path $_.FullName -Parent $releaseRoot
  Remove-Item -LiteralPath $_.FullName -Force
}

$manifestPath = Join-Path $releaseRoot "RELEASE-MANIFEST.md"
Assert-ChildPath -Path $manifestPath -Parent $releaseRoot
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
$manifest = @(
  "# Release Manifest",
  "",
  "Synced from: $workspaceRoot",
  "Synced at: $timestamp",
  "",
  "## Directories",
  ""
) + ($directories | ForEach-Object { "- $_" }) + @(
  "",
  "## Files",
  ""
) + ($files | ForEach-Object { "- $_" }) + @(
  "",
  "## Excluded Runtime Data",
  "",
  "- models, caches, logs, node_modules",
  "- local secrets, PID files, ledgers, SQLite/database files"
)

Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
Write-Host "GitHub release mirror synced: $releaseRoot"
