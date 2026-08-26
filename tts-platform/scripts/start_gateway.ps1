$ErrorActionPreference = "Stop"
$runtimeRoot = if ($env:TTS_RUNTIME_ROOT) { $env:TTS_RUNTIME_ROOT } else { "E:\tts_runtime" }
$python = Join-Path $runtimeRoot "envs\gateway\Scripts\python.exe"
$gatewayPort = if ($env:TTS_GATEWAY_PORT) { [int]$env:TTS_GATEWAY_PORT } else { 7000 }
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "TTS_GATEWAY_PORT must be between 1 and 65535."
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "TTS gateway Python not found: $python"
}
Set-Location (Join-Path $PSScriptRoot "..\gateway")
& $python -m uvicorn main:app --host 127.0.0.1 --port $gatewayPort
