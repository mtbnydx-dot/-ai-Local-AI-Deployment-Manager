# Stops the TTS workers that start_all.ps1 launched (Chatterbox, Qwen3-TTS,
# Fish). Each worker runs as "pwsh -File start_<x>.ps1" and its PID sits in
# <StateRoot>\start_<x>.pid. The gateway (start_gateway.pid) is left to
# stop_gateway.ps1, and the Step-Audio container is not touched.
#
# A PID is killed (with its process tree) only when CIM shows a pwsh process
# whose command line runs the matching start_<x>.ps1 through -File. A pid file
# whose process is gone, or whose PID now belongs to a process that started
# after the file was written (PID reuse), is removed. Any other process is
# reported and left running, and the script exits 1. -CheckOnly only reports.
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$StateRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) '.runtime'
}
if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) {
    Write-Host "No TTS worker state directory ($StateRoot); no worker was stopped."
    return
}

$pidFiles = @(Get-ChildItem -LiteralPath $StateRoot -Filter 'start_*.pid' -File | Where-Object { $_.Name -ne 'start_gateway.pid' } | Sort-Object Name)
if ($pidFiles.Count -eq 0) {
    Write-Host 'No TTS worker pid files; no worker was stopped.'
    return
}

$mismatched = 0
foreach ($file in $pidFiles) {
    $script = [System.IO.Path]::GetFileNameWithoutExtension($file.Name) + '.ps1'
    $raw = (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue | Select-Object -First 1)
    $workerPid = 0
    if (-not [int]::TryParse(([string]$raw).Trim(), [ref]$workerPid) -or $workerPid -le 0) {
        if ($CheckOnly) { Write-Host "[check] $($file.Name) holds no valid PID; it would be removed." }
        else { Remove-Item -LiteralPath $file.FullName -Force; Write-Host "Removed $($file.Name): it held no valid PID." }
        continue
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
    if (-not $process -and (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) {
        Write-Warning "PID $workerPid from $($file.Name) is running but CIM could not describe it; it was left running."
        $mismatched += 1
        continue
    }
    $reused = $process -and $process.CreationDate -and ($process.CreationDate -gt $file.LastWriteTime)
    if (-not $process -or $reused) {
        $reason = if ($reused) { "PID $workerPid now belongs to a newer process" } else { "PID $workerPid is not running" }
        if ($CheckOnly) { Write-Host "[check] $($file.Name) is stale ($reason); it would be removed." }
        else { Remove-Item -LiteralPath $file.FullName -Force; Write-Host "Removed stale $($file.Name) ($reason)." }
        continue
    }

    $commandLine = [string]$process.CommandLine
    $scriptPattern = '(?i)(^|\s)-File\s+"?([^"]*[\\/])?' + [regex]::Escape($script) + '"?(\s|$)'
    if ($process.Name -notmatch '^(?i)pwsh(\.exe)?$' -or $commandLine -notmatch $scriptPattern) {
        Write-Warning "PID $workerPid from $($file.Name) is $($process.Name), not pwsh -File $script; it was left running."
        $mismatched += 1
        continue
    }

    if ($CheckOnly) {
        Write-Host "[check] Verified TTS worker $script PID $workerPid; it would be stopped."
        continue
    }
    & taskkill.exe /PID $workerPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "taskkill could not stop TTS worker $script PID $workerPid (exit $LASTEXITCODE)."
        $mismatched += 1
        continue
    }
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Host "Stopped TTS worker $script PID $workerPid and its child processes."
}

if ($mismatched -gt 0) { exit 1 }
