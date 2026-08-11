[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$DeleteBranch,

  [switch]$Force
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

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$currentRoot = Split-Path -Parent $scriptRoot
$repoRootRaw = ((Invoke-Git -GitArgs @('-C', $currentRoot, 'rev-parse', '--show-toplevel')) | Select-Object -First 1).Trim()
$repoRoot = [System.IO.Path]::GetFullPath($repoRootRaw).TrimEnd('\')
$worktreesRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $repoRoot)).TrimEnd('\')
$target = if ([System.IO.Path]::IsPathRooted($Path)) {
  [System.IO.Path]::GetFullPath($Path)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $worktreesRoot $Path))
}

$allowedPrefix = $worktreesRoot + '\'
if (-not $target.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Worktrees must stay below $worktreesRoot. Refusing: $target"
}
if ($target.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to remove the current worktree.'
}

$registered = $false
$inTarget = $false
$branch = $null
$currentPath = $null
foreach ($line in (Invoke-Git -GitArgs @('-C', $repoRoot, 'worktree', 'list', '--porcelain'))) {
  if ($line -like 'worktree *') {
    $currentPath = [System.IO.Path]::GetFullPath($line.Substring(9).Trim())
    $inTarget = $currentPath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)
    if ($inTarget) { $registered = $true }
    continue
  }
  if ($inTarget -and $line -like 'branch refs/heads/*') {
    $branch = $line.Substring('branch refs/heads/'.Length).Trim()
  }
}
if (-not $registered) {
  throw "Not a registered worktree: $target"
}

if (-not $Force) {
  $changes = @(Invoke-Git -GitArgs @('-C', $target, 'status', '--porcelain'))
  if ($changes.Count -gt 0) {
    throw "Worktree has uncommitted changes. Commit or stash them, or pass -Force: $target"
  }
}

if (-not $PSCmdlet.ShouldProcess($target, 'Remove Git worktree')) {
  return
}

$removeArgs = @('-C', $repoRoot, 'worktree', 'remove')
if ($Force) { $removeArgs += '--force' }
$removeArgs += $target
Invoke-Git -GitArgs $removeArgs | Out-Null

if ($DeleteBranch -and $branch) {
  if ($branch -in @('main', 'integration')) {
    throw "The worktree was removed, but protected branch '$branch' was not deleted."
  }
  $deleteFlag = if ($Force) { '-D' } else { '-d' }
  Invoke-Git -GitArgs @('-C', $repoRoot, 'branch', $deleteFlag, $branch) | Out-Null
}

Write-Host "Worktree removed: $target"
if ($DeleteBranch -and $branch) { Write-Host "Branch removed: $branch" }
