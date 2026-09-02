# 一键启动语音克隆聚合平台：检测缺哪个服务就补哪个，全部就绪后按需打开浏览器。
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$GatewayOnly
)

$ErrorActionPreference = "Stop"
$s = $PSScriptRoot
. (Join-Path $s 'runtime-root.ps1')
$env:TTS_RUNTIME_ROOT = Get-TtsRuntimeRoot
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $s ".."))
$logRoot = Join-Path $projectRoot "logs"
$stateRoot = Join-Path $projectRoot ".runtime"
$gatewayPort = if ($env:TTS_GATEWAY_PORT) { [int]$env:TTS_GATEWAY_PORT } else { 7000 }
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "TTS_GATEWAY_PORT must be between 1 and 65535."
}
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

function Test-Port($port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Worker($name, $port, $script) {
    if (Test-Port $port) {
        Write-Host "[$name] 已在运行 (端口 $port)" -ForegroundColor Green
    } else {
        Write-Host "[$name] 启动中……" -ForegroundColor Yellow
        $slug = [System.IO.Path]::GetFileNameWithoutExtension($script)
        $outLog = Join-Path $logRoot "$slug.out.log"
        $errLog = Join-Path $logRoot "$slug.err.log"
        $process = Start-Process pwsh `
            -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $s $script) `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -LiteralPath (Join-Path $stateRoot "$slug.pid") -Value $process.Id -Encoding ascii
    }
}

Write-Host "==== 语音克隆聚合平台 ====" -ForegroundColor Cyan
Start-Worker "网关"           $gatewayPort "start_gateway.ps1"
if (-not $GatewayOnly) {
    Start-Worker "Chatterbox V3"  7011 "start_chatterbox.ps1"
    Start-Worker "Qwen3-TTS"      7012 "start_qwen.ps1"
    Start-Worker "Fish S2 Pro"    7013 "start_fish.ps1"
}

# Step-Audio-EditX：镜像存在且 Docker 在运行才启动
if (-not $GatewayOnly -and -not (Test-Port 7014)) {
    $dockerOk = $false
    try { docker info 2>$null | Out-Null; $dockerOk = ($LASTEXITCODE -eq 0) } catch {}
    if ($dockerOk -and (docker images -q step-audio-editx 2>$null)) {
        Write-Host "[Step-Audio] 启动 Docker 容器……" -ForegroundColor Yellow
        & "$s\start_step_docker.ps1"
    } else {
        Write-Host "[Step-Audio] 跳过（Docker 未运行或镜像未构建）" -ForegroundColor DarkGray
    }
} elseif (-not $GatewayOnly) {
    Write-Host "[Step-Audio] 已在运行 (端口 7014)" -ForegroundColor Green
}

# 等网关就绪再开浏览器
Write-Host "等待网关就绪……"
$deadline = (Get-Date).AddSeconds(60)
$ready = $false
$gatewayBase = "http://127.0.0.1:$gatewayPort"
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-RestMethod "$gatewayBase/health" -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch { Start-Sleep 1 }
}
if (-not $ready) {
    $gatewayErrorLog = Join-Path $logRoot "start_gateway.err.log"
    if (Test-Path -LiteralPath $gatewayErrorLog) {
        Get-Content -LiteralPath $gatewayErrorLog -Tail 12 | Write-Host
    }
    throw "TTS gateway did not become healthy within 60 seconds: $gatewayBase/health"
}
$uiUrl = if ($env:TTS_PUBLIC_URL) {
    $env:TTS_PUBLIC_URL
} elseif ($gatewayPort -eq 7000 -and (Test-Port 5176)) {
    "http://127.0.0.1:5176/gateway/tts/"
} else {
    "$gatewayBase/"
}
if (-not $NoBrowser) {
    Start-Process $uiUrl
}
Write-Host "完成！界面: $uiUrl （引擎第一次生成时才加载模型，首次会慢一点）" -ForegroundColor Cyan
