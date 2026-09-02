[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Path
)

$ErrorActionPreference = 'Stop'
$failed = $false

foreach ($item in $Path) {
  $resolved = (Resolve-Path -LiteralPath $item).Path
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($resolved, [ref]$tokens, [ref]$errors) | Out-Null
  if (@($errors).Count -eq 0) {
    Write-Host "PowerShell syntax OK: $resolved"
    continue
  }

  $failed = $true
  foreach ($errorItem in $errors) {
    Write-Error "${resolved}:$($errorItem.Extent.StartLineNumber): $($errorItem.Message)" -ErrorAction Continue
  }
}

if ($failed) { exit 1 }
