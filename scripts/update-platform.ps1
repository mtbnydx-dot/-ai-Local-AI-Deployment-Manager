[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipInstall,
  [switch]$SkipTests,

  # Set by 'platform update' in the live runtime root (06 section 9.4): update
  # <root>worktreesmain and deploy it. Without it the live root only explains itself.
  [switch]$Delegate
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$GitArgs)

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & git -C $projectRoot @GitArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    throw "git $($GitArgs -join ' ') failed:`n$($output -join [Environment]::NewLine)"
  }
  return @($output)
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git was not found. Install Git for Windows before using the updater.'
}

$insideWorkTree = $true
$gitProblem = $null
try {
  Invoke-Git -GitArgs @('rev-parse', '--is-inside-work-tree') | Out-Null
} catch {
  $insideWorkTree = $false
  $gitProblem = $_
}

if (-not $insideWorkTree) {
  $repoDir = Join-Path $projectRoot 'platform-repo.git'
  $mainTree = Join-Path (Join-Path $projectRoot 'worktrees') 'main'
  if (-not ((Test-Path -LiteralPath $repoDir -PathType Container) -and (Test-Path -LiteralPath $mainTree -PathType Container))) {
    # Not a live runtime root either: keep the original error.
    throw $gitProblem
  }

  if (-not $Delegate) {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    $zh = [regex]::Unescape('\u6b64\u76ee\u5f55\u662f\u7ebf\u4e0a\u8fd0\u884c\u6839\u76ee\u5f55\uff0c\u4e0d\u662f Git \u5de5\u4f5c\u533a\u3002\u8bf7\u8fd0\u884c\uff1aplatform update')
    Write-Host $zh
    Write-Host 'This is the live runtime root, not a Git checkout. Run: platform update'
    Write-Host '  platform update'
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Delegate"
    exit 2
  }

  function Invoke-MainGit {
    param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFailure)

    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $output = & git -C $mainTree @GitArgs 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
      throw "git $($GitArgs -join ' ') failed:`n$($output -join [Environment]::NewLine)"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
  }

  Write-Host "Fetching in $mainTree ..."
  Invoke-MainGit -GitArgs @('fetch', '--prune') | Out-Null
  $hasUpstream = (Invoke-MainGit -GitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') -AllowFailure).ExitCode -eq 0

  if ($CheckOnly) {
    # The same count 'platform version' reports (manager-core/platform/version.js, countNewerCommits).
    $node = if ([string]::IsNullOrWhiteSpace($env:NODE_EXE)) { 'node' } else { $env:NODE_EXE }
    $previousAiRoot = $env:AI_ROOT
    try {
      $env:AI_ROOT = $projectRoot
      & $node (Join-Path (Join-Path $projectRoot 'scripts') 'platformctl.js') version --fetch | Out-Host
      exit [int]$LASTEXITCODE
    } finally {
      if ($null -eq $previousAiRoot) { Remove-Item Env:AI_ROOT -ErrorAction SilentlyContinue } else { $env:AI_ROOT = $previousAiRoot }
    }
  }

  if ($hasUpstream) {
    Invoke-MainGit -GitArgs @('merge', '--ff-only', '@{u}') | Out-Null
  } else {
    Write-Host 'The main worktree has no upstream; skipping the merge.'
  }

  $deployScript = Join-Path (Join-Path $mainTree 'scripts') 'deploy-worktree.ps1'
  if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
    throw "The deploy script is missing: $deployScript"
  }
  $deployArgs = @{ LiveRoot = $projectRoot }
  if ($SkipTests) { $deployArgs['SkipTests'] = $true }
  & $deployScript @deployArgs
  if ($LASTEXITCODE -ne 0) { throw "Deploy failed with exit code $LASTEXITCODE." }
  exit 0
}

$branch = ((Invoke-Git -GitArgs @('branch', '--show-current')) | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
  throw 'The repository is in detached HEAD state. Check out a branch before updating.'
}

$trackedChanges = @(Invoke-Git -GitArgs @('status', '--porcelain=v1', '--untracked-files=no')) |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($trackedChanges.Count -gt 0) {
  throw 'Tracked files contain local changes. Commit or stash them before updating; the updater will not overwrite them.'
}

$upstream = ((Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')) | Select-Object -First 1).Trim()
$separator = $upstream.IndexOf('/')
if ($separator -lt 1) {
  throw "The current branch has no usable remote upstream: $upstream"
}
$remote = $upstream.Substring(0, $separator)

Write-Host "Fetching $upstream ..."
Invoke-Git -GitArgs @('fetch', '--prune', $remote) | Out-Null
$countsText = ((Invoke-Git -GitArgs @('rev-list', '--left-right', '--count', "HEAD...$upstream")) | Select-Object -First 1).Trim()
$counts = $countsText -split '\s+'
if ($counts.Count -ne 2) {
  throw "Could not parse Git ahead/behind state: $countsText"
}
$ahead = [int]$counts[0]
$behind = [int]$counts[1]
$before = ((Invoke-Git -GitArgs @('rev-parse', '--short=12', 'HEAD')) | Select-Object -First 1).Trim()

Write-Host "Branch: $branch | local ahead: $ahead | remote ahead: $behind"
if ($ahead -gt 0) {
  throw 'The local branch contains commits that are not on the remote. Resolve the branch history manually; automatic update was refused.'
}
if ($CheckOnly) {
  Write-Host ($(if ($behind -gt 0) { 'An update is available.' } else { 'Already up to date.' }))
  exit 0
}

if ($behind -gt 0) {
  Invoke-Git -GitArgs @('merge', '--ff-only', $upstream) | Out-Null
}
$after = ((Invoke-Git -GitArgs @('rev-parse', '--short=12', 'HEAD')) | Select-Object -First 1).Trim()

if (-not $SkipInstall) {
  & cmd.exe /d /c (Join-Path $projectRoot 'install-all.cmd')
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE." }
}
if (-not $SkipTests) {
  & cmd.exe /d /c (Join-Path $projectRoot 'test-all.cmd')
  if ($LASTEXITCODE -ne 0) { throw "Validation failed with exit code $LASTEXITCODE." }
}

Write-Host "Platform source updated: $before -> $after"
Write-Host 'Models, caches, .env files, databases, logs, voices, outputs, and running services were not modified.'

