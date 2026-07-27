[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path $PSScriptRoot).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
  $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$package.version
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "Version contains unsupported characters: $Version"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "artifacts\github-release"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot $OutputDirectory
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$packageName = "local-model-service-platform-v$Version"
$stagingRoot = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the release output directory: $fullPath"
  }
}

function Copy-ReleaseDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$RelativeSource,
    [string]$RelativeTarget = $RelativeSource
  )

  $source = Join-Path $projectRoot $RelativeSource
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Required release directory is missing: $RelativeSource"
  }
  $target = Join-Path $stagingRoot $RelativeTarget
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $robocopyArgs = @(
    $source,
    $target,
    "/E",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD",
    "node_modules",
    ".git",
    ".claude",
    "logs",
    "__pycache__",
    ".cache",
    "cache",
    "models",
    "audit-logs",
    "openwebui-exports",
    "venvs",
    "projects",
    "test-results",
    "playwright-report",
    "/XF",
    ".env",
    ".env.*",
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
    "service-api-key.json"
  )
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Failed to copy release directory '$RelativeSource' (robocopy exit code $LASTEXITCODE)."
  }
}

function Copy-ReleaseFile {
  param(
    [Parameter(Mandatory = $true)][string]$RelativeSource,
    [string]$RelativeTarget = $RelativeSource
  )

  $source = Join-Path $projectRoot $RelativeSource
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required release file is missing: $RelativeSource"
  }
  $target = Join-Path $stagingRoot $RelativeTarget
  $targetParent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-ChildPath -Path $stagingRoot -Parent $outputRoot
Assert-ChildPath -Path $zipPath -Parent $outputRoot
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

$releaseDirectories = @(
  ".github",
  "tests",
  "manager-core",
  "shared-public",
  "service-entry",
  "vllm-manager",
  "llama-manager",
  "model-capability-tests",
  "vllm",
  "deploy\public"
)
foreach ($directory in $releaseDirectories) {
  Copy-ReleaseDirectory -RelativeSource $directory
}

$releaseFiles = @(
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "playwright.config.cjs",
  "SYNC_POLICY.md",
  "install-all.cmd",
  "test-all.cmd",
  "start-service-entry.cmd",
  "start-service-entry-lan.cmd",
  "stop-service-entry.cmd",
  "status-service-entry.cmd",
  "start-claude-vllm-proxy.ps1",
  "claude-vllm-anthropic-proxy.py",
  "build-github-release.ps1"
)
foreach ($file in $releaseFiles) {
  Copy-ReleaseFile -RelativeSource $file
}
Copy-ReleaseFile -RelativeSource "deploy\public\.env.example"
Copy-ReleaseFile -RelativeSource "docs\client-setup-guide.md"
Copy-ReleaseFile -RelativeSource "docs\service-runbook.md"
Copy-ReleaseFile -RelativeSource "docs\subscription-proxy-guide.md"

$manifest = @(
  "# Release Manifest",
  "",
  "- Package: $packageName",
  "- Built: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))",
  "",
  "## Included",
  "",
  "- Application source for service-entry, vLLM manager, llama.cpp manager, and shared manager core",
  "- User documentation, tests, GitHub Actions CI, and public deployment examples",
  "- Windows install, start, stop, status, test, and packaging scripts",
  "",
  "## Intentionally excluded",
  "",
  "- node_modules, models, caches, logs, runtime ledgers, databases, PID files, and test output",
  "- .env files, local secrets, machine-local proxy data, screenshots, and internal audit/work files"
)
Set-Content -LiteralPath (Join-Path $stagingRoot "RELEASE-MANIFEST.md") -Value $manifest -Encoding UTF8

$forbiddenNames = Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Where-Object {
  ($_.Name -eq ".env") -or
  (($_.Name -like ".env.*") -and ($_.Name -ne ".env.example")) -or
  ($_.Name -match '(?i)(\.pem$|\.key$|id_rsa|id_ed25519|credential|\.secret\.json$|service-api-key\.json$)')
}
if ($forbiddenNames) {
  throw "Privacy check failed: forbidden file name(s) found in the staged release: $($forbiddenNames.Name -join ', ')"
}

$identityNeedles = @(
  $env:USERNAME,
  $env:COMPUTERNAME,
  $env:USERPROFILE,
  $projectRoot
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
$credentialPatterns = @(
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '\bAKIA[0-9A-Z]{16}\b',
  '\bgh[pousr]_[A-Za-z0-9]{20,}\b',
  '\bgithub_pat_[A-Za-z0-9_]{20,}\b',
  '\bsk-[A-Za-z0-9_-]{20,}\b',
  '\bxox[baprs]-[A-Za-z0-9-]{10,}\b'
)
$privacyHits = [System.Collections.Generic.List[string]]::new()
$textExtensions = @('.cmd', '.cjs', '.example', '.html', '.js', '.json', '.md', '.ps1', '.py', '.txt', '.yaml', '.yml')
$stagedTextFiles = Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Where-Object {
  ($textExtensions -contains $_.Extension.ToLowerInvariant()) -or ($_.Name -eq '.gitignore')
}
foreach ($file in $stagedTextFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if ($null -eq $content) { continue }
  foreach ($needle in $identityNeedles) {
    if ($content.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $privacyHits.Add($file.FullName.Substring($stagingRoot.Length + 1))
      break
    }
  }
  foreach ($pattern in $credentialPatterns) {
    if ($content -match $pattern) {
      $privacyHits.Add($file.FullName.Substring($stagingRoot.Length + 1))
      break
    }
  }
}
if ($privacyHits.Count -gt 0) {
  $uniqueHits = $privacyHits | Sort-Object -Unique
  throw "Privacy check failed in staged release file(s): $($uniqueHits -join ', ')"
}

Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $([System.IO.Path]::GetFileName($zipPath))" -Encoding ASCII

Write-Host "GitHub release archive created: $zipPath"
Write-Host "SHA256: $zipHash"
