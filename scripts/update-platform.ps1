[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipInstall,
  [switch]$SkipTests
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

Invoke-Git -GitArgs @('rev-parse', '--is-inside-work-tree') | Out-Null
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

