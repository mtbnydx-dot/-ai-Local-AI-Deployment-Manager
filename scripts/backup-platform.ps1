[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$BackupRoot = "",
    [int]$KeepDays = 14,
    [switch]$Register,
    [string]$DailyAt = "03:30",
    [switch]$NoPrune,
    [switch]$ListOnly
)

# Daily snapshot of the platform's small, valuable state:
#   * service-entry\data\platform-billing.sqlite  (billing ledger; copied with VACUUM INTO)
#   * service-entry\data\telemetry.sqlite  (telemetry and the audit-of-audit log; VACUUM INTO;
#     AI_TELEMETRY_DB overrides the source path). Optional: the store runs degraded on an
#     unreadable file and never repairs it (04-telemetry section 4.1), so a failed
#     snapshot becomes a manifest warning and the rest of the backup still runs. So does an
#     AI_TELEMETRY_DB that names no file. The store can grow to telemetry.maxDbMb (2 GB by
#     default); VACUUM INTO copies live pages only, but each kept snapshot is that size.
#   * TTS history database (tts-history.sqlite3) when present
#   * service-entry\data\*.json, <manager>\logs\*.json ledgers, .runtime\gateway-trust is NOT copied
# into backups\<yyyyMMdd-HHmm>\ with a manifest, pruning snapshots older than -KeepDays.
# Secrets never enter a backup (06 OPS-3b): the deny list below wins over every
# include. DPAPI CurrentUser blobs would not restore on another account anyway.
# -ListOnly prints the files a backup would copy as JSON and writes nothing.
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
if (-not $ListOnly) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $target /inheritance:r /grant:r "*$($currentSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect backup credentials with a private ACL' }
}
$manifest = [ordered]@{ format = 'local-ai-platform-backup-v2'; at = (Get-Date).ToString("o"); root = $Root; files = @(); warnings = @() }
$planned = [System.Collections.Generic.List[object]]::new()

# Root-relative paths (-like patterns) that are never copied: the secret store,
# the legacy runtime-key files and the MCP key file.
$deniedPaths = @(
    '.runtime\secrets\*',
    '*\logs\runtime-api-keys.json',
    'logs\runtime-secrets.json',
    '*\logs\runtime-secrets.json',
    '.runtime\platform-mcp\server.env'
)

function Get-RootRelativePath([string]$source) {
    $full = [IO.Path]::GetFullPath($source)
    $prefix = $Root.TrimEnd('\') + '\'
    if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $full.Substring($prefix.Length) }
    return $full
}

function Test-BackupDenied([string]$source) {
    $relative = Get-RootRelativePath $source
    foreach ($pattern in $deniedPaths) {
        if ($relative -like $pattern) { return $true }
    }
    return $false
}

function Copy-Sqlite([string]$source, [string]$destination) {
    # VACUUM INTO produces a consistent copy even while the service holds the file open.
    & node (Join-Path $PSScriptRoot "sqlite-snapshot.js") $source $destination
    if ($LASTEXITCODE -ne 0) { throw "sqlite snapshot failed for $source" }
}

function Add-File([string]$source, [string]$relative, [string]$kind) {
    if (-not (Test-Path -LiteralPath $source)) { return }
    if (Test-BackupDenied $source) { return }
    if ($ListOnly) {
        $planned.Add([ordered]@{ path = $relative; kind = $kind; source = (Get-RootRelativePath $source) })
        return
    }
    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    if ($kind -eq "sqlite") { Copy-Sqlite $source $destination } else { Copy-Item -LiteralPath $source -Destination $destination -Force }
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    $manifest.files += [ordered]@{ path = $relative; kind = $kind; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = $hash }
}

function Add-OptionalSqlite([string]$source, [string]$relative, [string]$warningCode) {
    try {
        Add-File $source $relative 'sqlite'
    } catch {
        $partial = Join-Path $target $relative
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
        $message = $_.Exception.Message
        Write-Warning "Skipped ${relative}: $message"
        $manifest.warnings += [ordered]@{ code = $warningCode; path = $relative; message = $message }
    }
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
# Last, after every must-keep file: telemetry is optional (see the header).
$telemetryDb = if ($env:AI_TELEMETRY_DB) { $env:AI_TELEMETRY_DB } else { Join-Path $Root 'service-entry\data\telemetry.sqlite' }
if (-not [IO.Path]::IsPathRooted($telemetryDb)) { $telemetryDb = Join-Path $Root $telemetryDb }
if ($env:AI_TELEMETRY_DB -and -not (Test-Path -LiteralPath $telemetryDb -PathType Leaf)) {
    # Add-File skips a missing source quietly; a configured location must not.
    $message = "AI_TELEMETRY_DB names a file that does not exist: $telemetryDb"
    Write-Warning "Skipped service-entry\data\telemetry.sqlite: $message"
    $manifest.warnings += [ordered]@{ code = 'telemetry_db_missing'; path = 'service-entry\data\telemetry.sqlite'; message = $message }
} else {
    Add-OptionalSqlite $telemetryDb 'service-entry\data\telemetry.sqlite' 'telemetry_snapshot_failed'
}

if ($ListOnly) {
    ConvertTo-Json -InputObject @($planned.ToArray()) -Depth 3
    return
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $target "backup-manifest.json") -Encoding UTF8
Write-Host ("Backup written: {0} ({1} files, {2} warnings)" -f $target, $manifest.files.Count, $manifest.warnings.Count)
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
