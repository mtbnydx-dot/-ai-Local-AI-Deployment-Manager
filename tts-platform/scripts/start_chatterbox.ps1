$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$python = Join-Path $runtimeRoot "envs\chatterbox\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Chatterbox Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python chatterbox_worker.py
