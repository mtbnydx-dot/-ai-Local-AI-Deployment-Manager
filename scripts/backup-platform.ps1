[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$BackupRoot = "",
    [int]$KeepDays = 14,
    [switch]$Register,
    [string]$DailyAt = "03:30"
)

# Daily snapshot of the platform's small, valuable state:
#   * service-entry\data\platform-billing.sqlite  (billing ledger; copied with VACUUM INTO)
#   * TTS history database (tts-history.sqlite3) when present
#   * service-entry\data\*.json, <manager>\logs\*.json ledgers, .runtime\gateway-trust is NOT copied
# into backups\<yyyyMMdd-HHmm>\ with a manifest, pruning snapshots older than -KeepDays.
# -Register creates a Windows scheduled task that runs this script daily.

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path
if (-not $BackupRoot) { $BackupRoot = Join-Path $Root "backups" }

if ($Register) {
    $taskName = "LocalAIPlatformBackup"
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Root `"$Root`" -KeepDays $KeepDays"
    schtasks /Create /F /SC DAILY /ST $DailyAt /TN $taskName /TR $action | Out-Null
    Write-Host "Registered scheduled task '$taskName' daily at $DailyAt."
    return
}

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$target = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Force -Path $target | Out-Null
$manifest = [ordered]@{ at = (Get-Date).ToString("o"); root = $Root; files = @() }

function Copy-Sqlite([string]$source, [string]$destination) {
    # VACUUM INTO produces a consistent copy even while the service holds the file open.
    & node (Join-Path $PSScriptRoot "sqlite-snapshot.js") $source $destination
    if ($LASTEXITCODE -ne 0) { throw "sqlite snapshot failed for $source" }
}

function Add-File([string]$source, [string]$relative, [string]$kind) {
    if (-not (Test-Path -LiteralPath $source)) { return }
    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    if ($kind -eq "sqlite") { Copy-Sqlite $source $destination } else { Copy-Item -LiteralPath $source -Destination $destination -Force }
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    $manifest.files += [ordered]@{ path = $relative; kind = $kind; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = $hash }
}

Add-File (Join-Path $Root "service-entry\data\platform-billing.sqlite") "service-entry\data\platform-billing.sqlite" "sqlite"
Get-ChildItem -LiteralPath (Join-Path $Root "service-entry\data") -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
    Add-File $_.FullName ("service-entry\data\" + $_.Name) "json"
}
foreach ($manager in @("vllm-manager", "llama-manager")) {
    $logs = Join-Path $Root "$manager\logs"
    Get-ChildItem -LiteralPath $logs -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
        Add-File $_.FullName ("$manager\logs\" + $_.Name) "json"
    }
}
$ttsRoots = @()
if ($env:TTS_DATA_ROOT) { $ttsRoots += $env:TTS_DATA_ROOT }
if ($env:TTS_RUNTIME_ROOT) { $ttsRoots += (Join-Path $env:TTS_RUNTIME_ROOT "data") }
$ttsRoots += (Join-Path $Root "tts-runtime\data")
$ttsRoots += (Join-Path $Root "tts-platform\data")
foreach ($candidate in $ttsRoots) {
    $db = Join-Path $candidate "tts-history.sqlite3"
    if (Test-Path -LiteralPath $db) { Add-File $db "tts\tts-history.sqlite3" "sqlite"; break }
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $target "backup-manifest.json") -Encoding UTF8
Write-Host ("Backup written: {0} ({1} files)" -f $target, $manifest.files.Count)

$cutoff = (Get-Date).AddDays(-[math]::Max(1, $KeepDays))
Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^\d{8}-\d{4}$' -and $_.CreationTime -lt $cutoff
} | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
    Write-Host "Pruned old backup $($_.Name)"
}
