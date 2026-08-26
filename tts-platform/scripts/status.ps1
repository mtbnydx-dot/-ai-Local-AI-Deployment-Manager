[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$gatewayPort = if ($env:TTS_GATEWAY_PORT) { [int]$env:TTS_GATEWAY_PORT } else { 7000 }
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "TTS_GATEWAY_PORT must be between 1 and 65535."
}

$apiKey = [string]$env:TTS_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $envFile = if ($env:TTS_ENV_FILE) { $env:TTS_ENV_FILE } else { Join-Path $projectRoot ".env" }
    if (-not [System.IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $projectRoot $envFile }
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $keyLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*TTS_API_KEY\s*=' } | Select-Object -First 1
        if ($keyLine -match '^\s*TTS_API_KEY\s*=\s*(.*?)\s*$') {
            $apiKey = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
}
$requestHeaders = @{}
if (-not [string]::IsNullOrWhiteSpace($apiKey)) { $requestHeaders.Authorization = "Bearer $apiKey" }

$rows = @()
foreach ($port in @($gatewayPort, 7011, 7012, 7013, 7014, 7015, 7016) | Select-Object -Unique) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        $rows += [pscustomobject]@{
            Port = $port
            Address = $listener.LocalAddress
            PID = $listener.OwningProcess
            Process = $process.ProcessName
        }
    } else {
        $rows += [pscustomobject]@{ Port = $port; Address = "-"; PID = "-"; Process = "-" }
    }
}
$rows | Format-Table -AutoSize

$gatewayBase = "http://127.0.0.1:$gatewayPort"
try {
    $health = Invoke-RestMethod -Uri "$gatewayBase/health" -TimeoutSec 3
    $system = Invoke-RestMethod -Uri "$gatewayBase/api/system" -Headers $requestHeaders -TimeoutSec 5
    [pscustomobject]@{
        Version = $health.version
        UptimeSeconds = $health.uptime_seconds
        ActiveJobs = $system.jobs.active
        TotalJobs = $system.jobs.total
        Outputs = $system.storage.outputs
        StorageMB = [math]::Round($system.storage.bytes / 1MB, 2)
    } | Format-List

    $engines = Invoke-RestMethod -Uri "$gatewayBase/api/engines" -Headers $requestHeaders -TimeoutSec 12
    $engines | Select-Object id, name, type, status, available, busy, latency_ms, detail | Format-Table -AutoSize
    $models = Invoke-RestMethod -Uri "$gatewayBase/api/models" -Headers $requestHeaders -TimeoutSec 12
    $models.items | Select-Object id, installed, available, model_loaded, busy, status | Format-Table -AutoSize
    exit 0
} catch {
    Write-Error "TTS gateway health check failed: $($_.Exception.Message)"
    exit 1
}
