$ErrorActionPreference = "Stop"
$runtimeRoot = if ($env:TTS_RUNTIME_ROOT) { $env:TTS_RUNTIME_ROOT } else { "E:\tts_runtime" }
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$python = Join-Path $runtimeRoot "envs\chatterbox\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Chatterbox Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python chatterbox_worker.py
