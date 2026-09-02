[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$LiveRoot,

  [string]$Version,

  [switch]$SkipTests,

  [switch]$AllowDirty,

  [switch]$IncludeLocalExtensions
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$GitArgs)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & git @GitArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "git $($GitArgs -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return @($output)
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside $Parent`: $fullPath"
  }
  return $fullPath
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $scriptRoot)).TrimEnd('\')
$repoRootRaw = ((Invoke-Git -GitArgs @('-C', $sourceRoot, 'rev-parse', '--show-toplevel')) | Select-Object -First 1).Trim()
$repoRoot = [System.IO.Path]::GetFullPath($repoRootRaw).TrimEnd('\')
if (-not $repoRoot.Equals($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Run this script from a platform worktree. Expected $repoRoot, got $sourceRoot."
}

if ([string]::IsNullOrWhiteSpace($LiveRoot)) {
  $worktreesRoot = Split-Path -Parent $sourceRoot
  $LiveRoot = Split-Path -Parent $worktreesRoot
}

if (-not (Test-Path -LiteralPath $LiveRoot -PathType Container)) {
  throw "Live root does not exist: $LiveRoot"
}
$liveFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $LiveRoot).Path).TrimEnd('\')
if ($liveFull.Equals($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to deploy a worktree onto itself.'
}

$changes = @(Invoke-Git -GitArgs @('-C', $sourceRoot, 'status', '--porcelain', '--untracked-files=normal'))
if ($changes.Count -gt 0 -and -not $AllowDirty) {
  throw 'The worktree has uncommitted changes. Commit them first or pass -AllowDirty explicitly.'
}

$commit = ((Invoke-Git -GitArgs @('-C', $sourceRoot, 'rev-parse', 'HEAD')) | Select-Object -First 1).Trim()
$shortCommit = ((Invoke-Git -GitArgs @('-C', $sourceRoot, 'rev-parse', '--short=12', 'HEAD')) | Select-Object -First 1).Trim()
$branch = ((Invoke-Git -GitArgs @('-C', $sourceRoot, 'branch', '--show-current')) | Select-Object -First 1).Trim()

if (-not $SkipTests) {
  & (Join-Path $sourceRoot 'test-all.cmd')
  if ($LASTEXITCODE -ne 0) {
    throw "Tests failed with exit code $LASTEXITCODE. Live files were not changed."
  }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
  $Version = "$($package.version)-git-$shortCommit"
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "Version contains unsupported characters: $Version"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$releaseRoot = Join-Path $sourceRoot "artifacts\worktree-deploy\$stamp-$shortCommit"
if (Test-Path -LiteralPath $releaseRoot) {
  throw "Release staging already exists: $releaseRoot"
}
New-Item -ItemType Directory -Path $releaseRoot | Out-Null

& (Join-Path $sourceRoot 'build-github-release.ps1') -Version $Version -OutputDirectory $releaseRoot

$packageName = "local-model-service-platform-v$Version"
$zipPath = Join-Path $releaseRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256"
$actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$declaredHash = ((Get-Content -LiteralPath $sidecarPath -Raw) -split '\s+')[0].ToLowerInvariant()
if ($actualHash -ne $declaredHash) {
  throw 'Release SHA256 sidecar does not match the generated archive.'
}

$extractRoot = Join-Path $releaseRoot 'extract'
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot
$packageRoot = Join-Path $extractRoot $packageName
if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
  throw "Extracted package root is missing: $packageRoot"
}

$deployItems = [System.Collections.Generic.List[object]]::new()
Get-ChildItem -LiteralPath $packageRoot -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($packageRoot.Length + 1)
  if ($relative -ne 'RELEASE-MANIFEST.md') {
    $deployItems.Add([pscustomobject]@{ Relative = $relative; Source = $_.FullName; Kind = 'release' })
  }
}

if ($IncludeLocalExtensions) {
  $localFiles = Invoke-Git -GitArgs @(
    '-C', $sourceRoot, 'ls-files', '--',
    'search-gateway', 'start-search-gateway.cmd', 'stop-search-gateway.cmd'
  )
  foreach ($relativeGitPath in $localFiles) {
    $relative = $relativeGitPath.Replace('/', '\')
    $source = Join-Path $sourceRoot $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $deployItems.Add([pscustomobject]@{ Relative = $relative; Source = $source; Kind = 'local-extension' })
    }
  }
}

$uniqueItems = @($deployItems | Group-Object { $_.Relative.ToLowerInvariant() } | ForEach-Object { $_.Group | Select-Object -First 1 })
$backupRoot = Join-Path $liveFull "artifacts\worktree-deploy-backups\$stamp-$shortCommit"
Assert-ChildPath -Path $backupRoot -Parent $liveFull | Out-Null

Write-Host "Prepared deployment"
Write-Host "  Branch:      $branch"
Write-Host "  Commit:      $commit"
Write-Host "  Files:       $($uniqueItems.Count)"
Write-Host "  Live root:   $liveFull"
Write-Host "  Backup root: $backupRoot"
Write-Host "  Archive:     $zipPath"
Write-Host "  SHA256:      $actualHash"

if (-not $PSCmdlet.ShouldProcess($liveFull, "Back up and deploy $($uniqueItems.Count) source files from commit $shortCommit")) {
  return
}

New-Item -ItemType Directory -Path $backupRoot | Out-Null
$records = [System.Collections.Generic.List[object]]::new()
foreach ($item in $uniqueItems) {
  $target = Assert-ChildPath -Path (Join-Path $liveFull $item.Relative) -Parent $liveFull
  $sourceHash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash.ToLowerInvariant()
  $targetExists = Test-Path -LiteralPath $target -PathType Leaf
  $targetHash = if ($targetExists) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }

  if ($targetHash -eq $sourceHash) {
    $records.Add([pscustomobject]@{
      path = $item.Relative; kind = $item.Kind; action = 'unchanged'; beforeSha256 = $targetHash; afterSha256 = $sourceHash
    })
    continue
  }

  if ($targetExists) {
    $backupPath = Assert-ChildPath -Path (Join-Path $backupRoot $item.Relative) -Parent $backupRoot
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
    Copy-Item -LiteralPath $target -Destination $backupPath -Force
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $item.Source -Destination $target -Force
  $deployedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($deployedHash -ne $sourceHash) {
    throw "Post-copy hash mismatch: $($item.Relative)"
  }
  $records.Add([pscustomobject]@{
    path = $item.Relative; kind = $item.Kind; action = if ($targetExists) { 'updated' } else { 'created' };
    beforeSha256 = $targetHash; afterSha256 = $deployedHash
  })
}

$manifest = [ordered]@{
  schemaVersion = 1
  deployedAt = (Get-Date).ToString('o')
  sourceWorktree = $sourceRoot
  branch = $branch
  commit = $commit
  liveRoot = $liveFull
  archive = $zipPath
  archiveSha256 = $actualHash
  includeLocalExtensions = [bool]$IncludeLocalExtensions
  files = @($records)
}
$manifestPath = Join-Path $backupRoot 'deployment-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host 'Deployment completed. No manager or model process was restarted.'
Write-Host "Backup manifest: $manifestPath"
