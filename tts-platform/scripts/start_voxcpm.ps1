$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$env:VOXCPM_MODEL = if ($env:VOXCPM_MODEL) { $env:VOXCPM_MODEL } else { Join-Path $runtimeRoot "models\VoxCPM2" }
$python = Join-Path $runtimeRoot "envs\voxcpm\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "VoxCPM Python not found: $python. Install it from the model manager first."
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python voxcpm_worker.py
