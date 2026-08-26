$rows = @()
foreach ($port in @(7000, 7011, 7012, 7013, 7014)) {
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

try {
    $platform = Invoke-RestMethod -Uri "http://127.0.0.1:5176/api/status" -TimeoutSec 12
    if ($platform.tts) {
        $platform.tts.engines | Select-Object id, name, type, available, detail | Format-Table -AutoSize
        if ($platform.tts.healthy) { exit 0 }
        Write-Error "service-entry reports that the TTS gateway is unhealthy: $($platform.tts.error)"
        exit 1
    }
} catch {
    # Fall back to direct loopback probing when service-entry is not available.
}

try {
    $engines = Invoke-RestMethod -Uri "http://127.0.0.1:7000/api/engines" -TimeoutSec 10
    $engines | Select-Object id, name, type, available, detail | Format-Table -AutoSize
    exit 0
} catch {
    Write-Error "TTS gateway health check failed: $($_.Exception.Message)"
    exit 1
}
