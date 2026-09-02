$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$env:QWEN_TTS_MODEL = if ($env:QWEN_TTS_MODEL) { $env:QWEN_TTS_MODEL } else { Join-Path $runtimeRoot "models\Qwen3-TTS-1.7B-Base" }
$python = Join-Path $runtimeRoot "envs\qwen\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Qwen TTS Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\workers")
& $python qwen_worker.py
