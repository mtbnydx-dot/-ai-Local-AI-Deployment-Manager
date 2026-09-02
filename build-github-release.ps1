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
    "dist",
    "/XF",
    ".env",
    ".env.*",
    ".manager.pid",
    "*.log",
    "*.pid",
    "*.tmp",
    "*.db",
    "*.db-*",
    "*.sqlite",
    "*.sqlite-*",
    "*.sqlite3",
    "*.sqlite3-*",
    "*.jsonl",
    "*.wal",
    "*.shm",
    "*.local.json",
    "*.secret.json",
    "stats-ledger.json",
    "jobs-ledger.json",
    "service-exposure.json",
    "service-api-key.json",
    "manager-public-proxy.js",
    "public-port-proxy.js",
    "start-manager-public-proxy.cmd",
    "stop-manager-public-proxy.cmd",
    "upnp-port-map.js"
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
  "platform-mcp",
  "search-gateway",
  "shared-public",
  "scripts",
  "service-entry",
  "tts-platform",
  "vllm-manager",
  "llama-manager",
  "model-capability-tests",
  "vllm",
  "deploy\public"
)
foreach ($directory in $releaseDirectories) {
  Copy-ReleaseDirectory -RelativeSource $directory
}

# service-entry/data is runtime state (fleet settings and the billing database).
# Keep manager-core/data because it contains bundled public reference tables.
$runtimeDataDirectories = @(
  "service-entry\data",
  "vllm-manager\data",
  "llama-manager\data",
  "tts-platform\voices",
  "tts-platform\outputs",
  "tts-platform\logs"
)
foreach ($relativeDataDirectory in $runtimeDataDirectories) {
  $runtimeDataPath = Join-Path $stagingRoot $relativeDataDirectory
  if (Test-Path -LiteralPath $runtimeDataPath) {
    Assert-ChildPath -Path $runtimeDataPath -Parent $stagingRoot
    Remove-Item -LiteralPath $runtimeDataPath -Recurse -Force
  }
}

$releaseFiles = @(
  ".gitattributes",
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
  "start-tts-platform.cmd",
  "status-tts-platform.cmd",
  "start-search-gateway.cmd",
  "stop-search-gateway.cmd",
  "install-tts-gateway.cmd",
  "update-platform.cmd",
  "start-platform-mcp.cmd",
  "stop-platform-mcp.cmd",
  "status-platform-mcp.cmd",
  "start-claude-vllm-proxy.ps1",
  "claude-vllm-anthropic-proxy.py",
  "build-github-release.ps1"
)
foreach ($file in $releaseFiles) {
  Copy-ReleaseFile -RelativeSource $file
}
Copy-ReleaseFile -RelativeSource "deploy\public\.env.example"
Copy-ReleaseFile -RelativeSource "platform-mcp\.env.example"
Copy-ReleaseFile -RelativeSource "search-gateway\.env.example"
Copy-ReleaseFile -RelativeSource "tts-platform\.env.example"
Copy-ReleaseFile -RelativeSource "docs\client-setup-guide.md"
Copy-ReleaseFile -RelativeSource "docs\git-worktree-workflow.md"
Copy-ReleaseFile -RelativeSource "docs\mcp-platform-guide.md"
Copy-ReleaseFile -RelativeSource "docs\qwen38-acceleration-guide.md"
Copy-ReleaseFile -RelativeSource "docs\service-runbook.md"
Copy-ReleaseFile -RelativeSource "docs\update-guide.md"

# README documentation links must survive packaging. This catches the common
# failure mode where a new guide is linked from README but omitted from the
# explicit, privacy-preserving release allowlist above.
$stagedReadme = Get-Content -LiteralPath (Join-Path $stagingRoot "README.md") -Raw
$linkedDocs = [regex]::Matches($stagedReadme, '\]\((docs/[^)#?]+\.md)(?:#[^)]*)?\)') |
  ForEach-Object { $_.Groups[1].Value.Replace('/', '\') } |
  Sort-Object -Unique
foreach ($linkedDoc in $linkedDocs) {
  if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot $linkedDoc) -PathType Leaf)) {
    throw "README links a documentation file that is missing from the staged release: $linkedDoc"
  }
}

$manifest = @(
  "# Release Manifest",
  "",
  "- Package: $packageName",
  "- Built: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))",
  "",
  "## Included",
  "",
  "- Application source for service-entry, vLLM manager, llama.cpp manager, TTS, search gateway, platform MCP, and shared manager core",
  "- User documentation, tests, GitHub Actions CI, and public deployment examples",
  "- Windows install, safe Git update, start, stop, status, test, and packaging scripts",
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
  ($_.Name -match '(?i)(\.pem$|\.key$|id_rsa|id_ed25519|credential|\.secret\.json$|service-api-key\.json$|\.sqlite3?(?:-(?:wal|shm))?$|\.db(?:-(?:wal|shm))?$|\.jsonl$)')
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
$textExtensions = @('.cmd', '.cjs', '.example', '.html', '.js', '.json', '.md', '.ps1', '.py', '.ts', '.txt', '.xml', '.yaml', '.yml')
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
