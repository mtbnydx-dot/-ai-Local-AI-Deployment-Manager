[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$LiveRoot,

  [string]$Version,

  [switch]$SkipTests,

  [switch]$AllowDirty,

  [switch]$IncludeLocalExtensions,

  [switch]$AllowLiveDrift,

  [switch]$DriftOnly,

  # What to do with the components the deploy touched (06 section 9.3). Nothing
  # is restarted by default; 'changed' and 'all' go through the supervisor.
  [ValidateSet('none', 'changed', 'all')]
  [string]$Restart = 'none',

  # Keep stale deploy artifacts instead of pruning them (with a backup).
  [switch]$NoPrune,

  # Copy the files only: no prune, dependency, build, version.json or restart step.
  [switch]$SkipPostDeploy
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

# Post-deploy steps (06 section 9.3) run through the platform CLI. A real deploy
# uses the newly deployed copy in the live root; the -WhatIf preview uses this
# worktree's copy, because the live root may not have the new CLI yet. Either
# way the CLI works on the live root named in AI_ROOT.
function Invoke-PostDeploy {
  param(
    [Parameter(Mandatory = $true)][string]$CliRoot,
    [Parameter(Mandatory = $true)][string]$AiRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [switch]$Preview
  )

  $cli = Join-Path (Join-Path $CliRoot 'scripts') 'platformctl.js'
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "The platform CLI is missing: $cli"
  }
  $node = if ([string]::IsNullOrWhiteSpace($env:NODE_EXE)) { 'node' } else { $env:NODE_EXE }
  $cliArgs = @($cli, 'post-deploy', '--manifest', $ManifestPath, '--restart', $Restart)
  if ($NoPrune) { $cliArgs += '--no-prune' }
  if ($Preview) { $cliArgs += '--dry-run' }

  $previousAiRoot = $env:AI_ROOT
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $env:AI_ROOT = $AiRoot
    # Windows PowerShell 5 can promote native stderr into error records when
    # deployment output is captured. The CLI's exit code decides success.
    $ErrorActionPreference = 'Continue'
    # Out-Host keeps the CLI output out of this function's return value.
    & $node @cliArgs | Out-Host
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -eq $previousAiRoot) { Remove-Item Env:AI_ROOT -ErrorAction SilentlyContinue } else { $env:AI_ROOT = $previousAiRoot }
  }
  return [int]$exitCode
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
if ($changes.Count -gt 0 -and -not $AllowDirty -and -not $DriftOnly) {
  throw 'The worktree has uncommitted changes. Commit them first or pass -AllowDirty explicitly.'
}

# Live drift: a file that was hand-edited in the live root after its last deploy
# would be silently overwritten. Compare every previously deployed path with the
# hash recorded by the newest manifest that touched it.
function Get-LiveDrift {
  param([Parameter(Mandatory = $true)][string]$LiveRootPath)

  $backupsRoot = Join-Path $LiveRootPath 'artifacts\worktree-deploy-backups'
  $expected = @{}
  if (Test-Path -LiteralPath $backupsRoot -PathType Container) {
    $manifests = Get-ChildItem -LiteralPath $backupsRoot -Directory |
      ForEach-Object { Join-Path $_.FullName 'deployment-manifest.json' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      ForEach-Object {
        try { $data = Get-Content -LiteralPath $_ -Raw | ConvertFrom-Json } catch { $data = $null }
        if ($data -and $data.files) { [pscustomobject]@{ Path = $_; DeployedAt = [string]$data.deployedAt; Data = $data } }
      } |
      Sort-Object DeployedAt
    foreach ($manifest in $manifests) {
      foreach ($file in $manifest.Data.files) {
        if ($file.afterSha256) { $expected[([string]$file.path).Replace('/', '\')] = [string]$file.afterSha256 }
      }
    }
  }

  $drift = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in $expected.GetEnumerator()) {
    $target = Join-Path $LiveRootPath $entry.Key
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    $currentHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne $entry.Value) {
      $drift.Add([pscustomobject]@{ path = $entry.Key; deployedSha256 = $entry.Value; liveSha256 = $currentHash })
    }
  }
  return @($drift | Sort-Object path)
}

$liveDrift = @(Get-LiveDrift -LiveRootPath $liveFull)
if ($liveDrift.Count -gt 0) {
  Write-Host "Live drift detected: $($liveDrift.Count) file(s) changed in $liveFull since their last deploy:"
  foreach ($item in $liveDrift) { Write-Host "  $($item.path)" }
  Write-Host 'Port these edits into a worktree (three-way merge against the deploy backup) before deploying, or pass -AllowLiveDrift to overwrite them (they are still copied to the backup root).'
} else {
  Write-Host 'Live drift check: no hand edits detected since the last deploy.'
}
if ($DriftOnly) {
  return
}
if ($liveDrift.Count -gt 0 -and -not $AllowLiveDrift) {
  throw "Refusing to overwrite $($liveDrift.Count) hand-edited live file(s). Pass -AllowLiveDrift only after porting them."
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

# Staging only writes below this worktree's artifacts folder, and the -WhatIf preview
# needs the extracted release to compare against the live root, so staging runs
# for real even under -WhatIf. Only the live root is protected by ShouldProcess.
$callerWhatIfPreference = $WhatIfPreference
$WhatIfPreference = $false

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
$WhatIfPreference = $callerWhatIfPreference

Write-Host "Prepared deployment"
Write-Host "  Branch:      $branch"
Write-Host "  Commit:      $commit"
Write-Host "  Files:       $($uniqueItems.Count)"
Write-Host "  Live root:   $liveFull"
Write-Host "  Backup root: $backupRoot"
Write-Host "  Archive:     $zipPath"
Write-Host "  SHA256:      $actualHash"

if (-not $PSCmdlet.ShouldProcess($liveFull, "Back up and deploy $($uniqueItems.Count) source files from commit $shortCommit")) {
  if (-not $SkipPostDeploy) {
    # Preview the post-steps against the manifest this deploy would write. The
    # live root is only read; the plan manifest lives in the release staging folder.
    $plannedRecords = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $uniqueItems) {
      $target = Join-Path $liveFull $item.Relative
      $sourceHash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash.ToLowerInvariant()
      $targetExists = Test-Path -LiteralPath $target -PathType Leaf
      $targetHash = if ($targetExists) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
      $plannedAction = if ($targetHash -eq $sourceHash) { 'unchanged' } elseif ($targetExists) { 'updated' } else { 'created' }
      $plannedRecords.Add([pscustomobject]@{
        path = $item.Relative; kind = $item.Kind; action = $plannedAction; beforeSha256 = $targetHash; afterSha256 = $sourceHash
      })
    }
    $planManifest = [ordered]@{
      schemaVersion = 1
      deployedAt = (Get-Date).ToString('o')
      sourceWorktree = $sourceRoot
      branch = $branch
      commit = $commit
      liveRoot = $liveFull
      archive = $zipPath
      archiveSha256 = $actualHash
      includeLocalExtensions = [bool]$IncludeLocalExtensions
      liveDrift = @($liveDrift)
      files = @($plannedRecords)
    }
    $planPath = Join-Path $releaseRoot 'plan-deployment-manifest.json'
    $planManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $planPath -Encoding UTF8
    $planCode = Invoke-PostDeploy -CliRoot $sourceRoot -AiRoot $liveFull -ManifestPath $planPath -Preview
    if ($planCode -ne 0) {
      Write-Warning "The post-deploy preview failed (exit $planCode)."
    }
  }
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
  liveDrift = @($liveDrift)
  files = @($records)
}
$manifestPath = Join-Path $backupRoot 'deployment-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Backup manifest: $manifestPath"

if ($SkipPostDeploy) {
  Write-Host 'Files deployed. Post-deploy steps were skipped (-SkipPostDeploy).'
  Write-Host "Run later: platform post-deploy --manifest `"$manifestPath`""
  Write-Host 'Deployment completed. No manager or model process was restarted.'
  return
}

$postDeployCode = Invoke-PostDeploy -CliRoot $liveFull -AiRoot $liveFull -ManifestPath $manifestPath
if ($postDeployCode -ne 0) {
  $failedSteps = 'unknown'
  $resultPath = Join-Path $backupRoot 'post-deploy.json'
  if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
    try {
      $postResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
      if ($postResult.failed) { $failedSteps = (@($postResult.failed) -join ', ') }
    } catch { }
  }
  throw ('Files are deployed; post-steps failed: {0}; run: platform post-deploy --manifest "{1}"' -f $failedSteps, $manifestPath)
}

if ($Restart -eq 'none') {
  Write-Host 'Deployment completed. No manager or model process was restarted.'
} else {
  Write-Host 'Deployment completed. Model containers were not restarted.'
}
