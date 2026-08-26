$ErrorActionPreference = "Stop"
$runtimeRoot = if ($env:TTS_RUNTIME_ROOT) { $env:TTS_RUNTIME_ROOT } else { "E:\tts_runtime" }
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$env:QWEN_DESIGN_MODEL = if ($env:QWEN_DESIGN_MODEL) { $env:QWEN_DESIGN_MODEL } else { Join-Path $runtimeRoot "models\Qwen3-TTS-12Hz-1.7B-VoiceDesign" }
$python = Join-Path $runtimeRoot "envs\qwen\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Qwen TTS Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python qwen_design_worker.py
