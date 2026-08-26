$ErrorActionPreference = "Stop"
$runtimeRoot = if ($env:TTS_RUNTIME_ROOT) { $env:TTS_RUNTIME_ROOT } else { "E:\tts_runtime" }
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$env:VOXCPM_MODEL = if ($env:VOXCPM_MODEL) { $env:VOXCPM_MODEL } else { Join-Path $runtimeRoot "models\VoxCPM2" }
$python = Join-Path $runtimeRoot "envs\voxcpm\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "VoxCPM Python not found: $python. Install it from the model manager first."
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python voxcpm_worker.py
