[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]*$')]
  [string]$Branch,

  [string]$Path,

  [string]$StartPoint = 'main'
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

if ($Branch.Contains('..') -or $Branch.Contains('//') -or $Branch.EndsWith('/')) {
  throw "Unsafe branch name: $Branch"
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$currentRoot = Split-Path -Parent $scriptRoot
$repoRootRaw = ((Invoke-Git -GitArgs @('-C', $currentRoot, 'rev-parse', '--show-toplevel')) | Select-Object -First 1).Trim()
$repoRoot = [System.IO.Path]::GetFullPath($repoRootRaw).TrimEnd('\')
$worktreesRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $repoRoot)).TrimEnd('\')

if ([string]::IsNullOrWhiteSpace($Path)) {
  $directoryName = $Branch -replace '[\/]+', '-'
  $Path = Join-Path $worktreesRoot $directoryName
} elseif (-not [System.IO.Path]::IsPathRooted($Path)) {
  $Path = Join-Path $worktreesRoot $Path
}

$target = [System.IO.Path]::GetFullPath($Path)
$allowedPrefix = $worktreesRoot + '\'
if (-not $target.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Worktrees must stay below $worktreesRoot. Refusing: $target"
}
if ($target.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The current worktree cannot be reused as a new worktree.'
}
if (Test-Path -LiteralPath $target) {
  throw "Target already exists: $target"
}

Invoke-Git -GitArgs @('-C', $repoRoot, 'rev-parse', '--verify', "$StartPoint^{commit}") | Out-Null
& git -C $repoRoot show-ref --verify --quiet "refs/heads/$Branch"
$branchExists = $LASTEXITCODE -eq 0

if ($branchExists) {
  Invoke-Git -GitArgs @('-C', $repoRoot, 'worktree', 'add', $target, $Branch) | Out-Null
} else {
  Invoke-Git -GitArgs @('-C', $repoRoot, 'worktree', 'add', '-b', $Branch, $target, $StartPoint) | Out-Null
}

Write-Host "Worktree created"
Write-Host "  Branch: $Branch"
Write-Host "  Path:   $target"
Write-Host "  Base:   $StartPoint"
