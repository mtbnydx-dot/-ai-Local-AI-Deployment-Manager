$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$env:QWEN_DESIGN_MODEL = if ($env:QWEN_DESIGN_MODEL) { $env:QWEN_DESIGN_MODEL } else { Join-Path $runtimeRoot "models\Qwen3-TTS-12Hz-1.7B-VoiceDesign" }
$python = Join-Path $runtimeRoot "envs\qwen\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Qwen TTS Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python qwen_design_worker.py
