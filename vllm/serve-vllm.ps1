param(
    [Parameter(Mandatory = $true)]
    [string]$Model,

    [string]$Name = "",

    [int]$Port = 8000,

    [int]$MaxModelLen = 8192,

    [double]$GpuMemoryUtilization = 0.90,

    [string]$DType = "auto",

    [string]$Quantization = "",

    [string]$HfCache = "",

    [string]$ModelsRoot = "",

    [string]$ContainerName = "vllm-local",

    [string]$Image = "vllm/vllm-openai:v0.21.0"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $HfCache) {
    $HfCache = Join-Path $repoRoot "cache\huggingface"
}
if (-not $ModelsRoot) {
    $ModelsRoot = Join-Path $repoRoot "models"
}

$docker = $env:DOCKER_EXE
if (-not $docker) {
    $docker = "docker"
}

New-Item -ItemType Directory -Path $HfCache, $ModelsRoot -Force | Out-Null

if (-not $Name) {
    $leaf = Split-Path $Model -Leaf
    if (-not $leaf) {
        $leaf = ($Model -replace "[\\/]", "__")
    }
    $Name = $leaf.ToLower()
}

$modelArg = $Model
if (Test-Path $Model) {
    $resolved = Resolve-Path -LiteralPath $Model
    $modelArg = "/models/" + (Split-Path $resolved -Leaf)
}

Write-Host "Stopping any existing container named $ContainerName"
$existing = & $docker ps -a --filter "name=^/${ContainerName}$" --format "{{.Names}}" 2>$null
if ($existing -contains $ContainerName) {
    & $docker rm -f $ContainerName | Out-Null
}

$dockerArgs = @(
    "run", "-d",
    "--name", $ContainerName,
    "--label", "ai.manager=vllm-script",
    "--label", "ai.manager.engine=vllm",
    "--gpus", "all",
    "--ipc=host",
    "-p", "${Port}:8000",
    "-v", "${HfCache}:/root/.cache/huggingface",
    "-v", "${ModelsRoot}:/models"
)

if ($env:HF_TOKEN) {
    $dockerArgs += @("-e", "HF_TOKEN=$($env:HF_TOKEN)")
}

$dockerArgs += @(
    $Image,
    "--model", $modelArg,
    "--served-model-name", $Name,
    "--dtype", $DType,
    "--max-model-len", "$MaxModelLen",
    "--gpu-memory-utilization", "$GpuMemoryUtilization"
)

if ($Quantization) {
    $dockerArgs += @("--quantization", $Quantization)
}

Write-Host "Starting vLLM service"
Write-Host "Model: $Model"
Write-Host "Served name: $Name"
Write-Host "URL: http://127.0.0.1:$Port/v1"

& $docker @dockerArgs

Write-Host ""
Write-Host "Waiting for /v1/models ..."
for ($i = 1; $i -le 120; $i++) {
    Start-Sleep -Seconds 5
    try {
        $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 3
        Write-Host "Ready."
        $models | ConvertTo-Json -Depth 6
        exit 0
    } catch {
        if ($i % 6 -eq 0) {
            Write-Host "Still loading... $($i * 5)s"
        }
    }
}

Write-Host "vLLM did not become ready in time. Recent logs:"
& $docker logs --tail 120 $ContainerName
exit 1
