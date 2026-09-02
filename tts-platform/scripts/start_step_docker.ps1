[CmdletBinding()]
param([switch]$Recreate)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$repo = Join-Path $runtimeRoot "repos\Step-Audio-EditX"
$hfRoot = Join-Path $runtimeRoot "hf\hub"
$image = if ($env:TTS_STEP_IMAGE) { $env:TTS_STEP_IMAGE } else { "step-audio-editx:ffmpeg" }

docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker is not available."
}

$containerExists = [bool](docker ps -a --filter "name=^/step-audio$" --format "{{.Names}}" 2>$null)
$containerRunning = [bool](docker ps --filter "name=^/step-audio$" --filter "status=running" --format "{{.Names}}" 2>$null)
if ($containerRunning -and -not $Recreate) {
    Write-Host "Step-Audio container is already running; leaving it unchanged." -ForegroundColor Green
    exit 0
}
if ($containerExists -and -not $Recreate) {
    docker start step-audio | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to start the Step-Audio container." }
    Write-Host "Step-Audio container resumed." -ForegroundColor Green
    exit 0
}

$imageId = docker images -q $image 2>$null
if (-not $imageId) {
    Write-Host "Building the Step-Audio-EditX image. The first build can take a while."
    docker build -t $image $repo
    if ($LASTEXITCODE -ne 0) { throw "Step-Audio image build failed." }
}

if ($containerExists) {
    docker rm -f step-audio | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to remove the existing step-audio container." }
}

# The image provides dependencies; application source is mounted read-only.
Copy-Item (Join-Path $PSScriptRoot "..\workers\step_server.py") (Join-Path $repo "step_server.py") -Force
$modelMount = Join-Path $hfRoot "models--stepfun-ai--Step-Audio-EditX"
$tokenizerMount = Join-Path $hfRoot "models--stepfun-ai--Step-Audio-Tokenizer"

docker run -d --name step-audio --gpus all -p 127.0.0.1:7014:7014 `
    -v "${repo}:/src:ro" `
    -v "${modelMount}:/hfmodel:ro" `
    -v "${tokenizerMount}:/hftok:ro" `
    -e STEP_MODEL_PATH=/hfmodel/snapshots/5fe2f8a05c2353301ad47d3c1747b262115da138 `
    -e STEP_TOKENIZER_PATH=/hftok/snapshots/af7e5a3ec06175a7facae9d4100073d6e4dbb36c `
    -e STEP_GPU_MEM_UTIL=0.15 `
    -w /src `
    $image /app/.venv/bin/python step_server.py | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Step-Audio container launch failed." }
Write-Host "Step-Audio is listening only on 127.0.0.1:7014. Logs: docker logs -f step-audio"
