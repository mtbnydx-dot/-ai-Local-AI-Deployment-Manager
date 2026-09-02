[CmdletBinding()]
param([string]$Python = '3.12')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$environmentRoot = Join-Path $runtimeRoot 'envs\gateway'
$pythonExe = Join-Path $environmentRoot 'Scripts\python.exe'
$requirements = Join-Path (Split-Path -Parent $PSScriptRoot) 'requirements-gateway.txt'
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    throw 'uv was not found. Install uv first, then run install-tts-gateway.cmd again.'
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
    & $uv.Source venv $environmentRoot --python $Python
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed with exit code $LASTEXITCODE." }
}
& $uv.Source pip install --python $pythonExe --requirement $requirements
if ($LASTEXITCODE -ne 0) { throw "uv pip install failed with exit code $LASTEXITCODE." }

Write-Host "TTS gateway environment is ready: $environmentRoot"
Write-Host "Runtime root: $runtimeRoot"

