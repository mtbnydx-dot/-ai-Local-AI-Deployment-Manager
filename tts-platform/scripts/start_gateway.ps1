$ErrorActionPreference = "Stop"
$runtimeRoot = if ($env:TTS_RUNTIME_ROOT) { $env:TTS_RUNTIME_ROOT } else { "E:\tts_runtime" }
$python = Join-Path $runtimeRoot "envs\gateway\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "TTS gateway Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\gateway")
& $python -m uvicorn main:app --host 127.0.0.1 --port 7000
