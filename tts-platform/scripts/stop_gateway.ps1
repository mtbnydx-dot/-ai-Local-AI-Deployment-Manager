[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$recordFile = Join-Path $runtimeRoot 'state\gateway-process.json'
if (-not (Test-Path -LiteralPath $recordFile)) {
    Write-Host 'No managed TTS gateway process record; no process was stopped.'
    return
}
$record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
$candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)" -ErrorAction SilentlyContinue
if (-not $candidate) { Write-Host 'Managed TTS gateway is already stopped.'; return }
$expectedExe = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'envs\gateway\Scripts\python.exe'))
$expectedDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\gateway'))
# PowerShell 7 may deserialize ISO timestamps as DateTime. Parsing that value
# again through its culture-specific string loses the UTC kind and offset.
$recordStart = if ($record.startedAt -is [datetime]) {
    $record.startedAt
} else {
    [datetime]::Parse([string]$record.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
}
$sameStart = [math]::Abs(($candidate.CreationDate.ToUniversalTime() - $recordStart.ToUniversalTime()).TotalSeconds) -lt 1
if ($candidate.ExecutablePath -ne $expectedExe -or $record.directory -ne $expectedDirectory -or -not $sameStart -or $candidate.CommandLine -notmatch '\s-m\s+uvicorn\s+main:app\s+--host\s+127\.0\.0\.1\s+--port\s+\d+') {
    throw 'TTS process identity did not match; nothing was stopped.'
}
if ($CheckOnly) { Write-Host "Verified managed TTS gateway PID $($candidate.ProcessId)."; return }
Stop-Process -Id $candidate.ProcessId -Force
Write-Host "Stopped managed TTS gateway PID $($candidate.ProcessId)."
