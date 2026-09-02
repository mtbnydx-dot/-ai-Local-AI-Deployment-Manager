$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$repo = Join-Path $runtimeRoot "repos\fish-speech"
$python = Join-Path $runtimeRoot "envs\fish\Scripts\python.exe"
$model = Join-Path $runtimeRoot "models\s2-pro"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Fish Speech Python not found: $python"
}
Set-Location $repo
& $python tools\api_server.py `
    --llama-checkpoint-path $model `
    --decoder-checkpoint-path (Join-Path $model "codec.pth") `
    --half `
    --listen 127.0.0.1:7013
