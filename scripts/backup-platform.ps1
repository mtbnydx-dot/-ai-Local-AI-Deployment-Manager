[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$BackupRoot = "",
    [int]$KeepDays = 14,
    [switch]$Register,
    [string]$DailyAt = "03:30",
    [switch]$NoPrune
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
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Root `"$Root`" -BackupRoot `"$BackupRoot`" -KeepDays $KeepDays"
    schtasks /Create /F /SC DAILY /ST $DailyAt /TN $taskName /TR $action | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Scheduled backup registration failed" }
    Write-Host "Registered scheduled task '$taskName' daily at $DailyAt."
    return
}

$BackupRoot = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$target = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Force -Path $target | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $target /inheritance:r /grant:r "*$($currentSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect backup credentials with a private ACL' }
$manifest = [ordered]@{ format = 'local-ai-platform-backup-v2'; at = (Get-Date).ToString("o"); root = $Root; files = @() }

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
Get-ChildItem -LiteralPath (Join-Path $Root 'service-entry\data\model-migrations') -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Add-File $_.FullName ('service-entry\data\model-migrations\' + $_.Name) 'json'
}
foreach ($manager in @("vllm-manager", "llama-manager")) {
    $logs = Join-Path $Root "$manager\logs"
    Get-ChildItem -LiteralPath $logs -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
        Add-File $_.FullName ("$manager\logs\" + $_.Name) "json"
    }
}
$ttsEnvFile = if ($env:TTS_ENV_FILE) { $env:TTS_ENV_FILE } else { Join-Path $Root 'tts-platform\.env' }
$ttsData = $env:TTS_DATA_ROOT
if (-not $ttsData -and (Test-Path -LiteralPath $ttsEnvFile)) {
    foreach ($line in Get-Content -LiteralPath $ttsEnvFile) {
        if ($line -match '^\s*TTS_DATA_ROOT\s*=\s*(.+)\s*$') { $ttsData = $Matches[1].Trim().Trim('"').Trim("'") }
    }
}
if (-not $ttsData) { $ttsData = Join-Path $Root 'tts-platform' }
if (-not [IO.Path]::IsPathRooted($ttsData)) { $ttsData = Join-Path $Root "tts-platform\$ttsData" }
$ttsData = [IO.Path]::GetFullPath($ttsData).TrimEnd('\')
$manifest.ttsDataRoot = $ttsData
Add-File (Join-Path $ttsData 'tts-history.sqlite3') 'tts\tts-history.sqlite3' 'sqlite'
foreach ($folder in @('voices','outputs')) {
    $sourceFolder = Join-Path $ttsData $folder
    Get-ChildItem -LiteralPath $sourceFolder -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        Add-File $_.FullName ('tts\' + $_.FullName.Substring($ttsData.Length + 1)) 'data'
    }
}
Add-File $ttsEnvFile 'config\tts.env' 'config'
foreach ($relative in @('.runtime\platform-mcp\server.env','search-gateway\.env')) {
    Add-File (Join-Path $Root $relative) (Join-Path 'config' $relative) 'config'
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $target "backup-manifest.json") -Encoding UTF8
Write-Host ("Backup written: {0} ({1} files)" -f $target, $manifest.files.Count)
& node (Join-Path $PSScriptRoot 'verify-backup.js') $target
if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed; retention has not run.' }
if ($NoPrune) { return }

$cutoff = (Get-Date).AddDays(-[math]::Max(1, $KeepDays))
Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^\d{8}-\d{6}-\d{3}$' -and $_.CreationTime -lt $cutoff
} | ForEach-Object {
    $resolvedTarget = [IO.Path]::GetFullPath($_.FullName)
    if (-not $resolvedTarget.StartsWith($BackupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe backup retention path' }
    $oldManifest = Join-Path $resolvedTarget 'backup-manifest.json'
    if (-not (Test-Path -LiteralPath $oldManifest)) { return }
    $old = Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json
    if ($old.format -ne 'local-ai-platform-backup-v2' -or $old.root -ne $Root) { return }
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
    Write-Host "Pruned old backup $($_.Name)"
}
