$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$python = Join-Path $runtimeRoot "envs\gateway\Scripts\python.exe"
$gatewayPort = if ($env:TTS_GATEWAY_PORT) { [int]$env:TTS_GATEWAY_PORT } else { 7000 }
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "TTS_GATEWAY_PORT must be between 1 and 65535."
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "TTS gateway Python not found: $python. Run install-tts-gateway.cmd from the platform root first."
}
$gatewayDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\gateway'))
$stateDirectory = Join-Path $runtimeRoot 'state'
New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
$recordFile = Join-Path $stateDirectory 'gateway-process.json'
$process = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','main:app','--host','127.0.0.1','--port',"$gatewayPort") -WorkingDirectory $gatewayDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDirectory 'gateway-stdout.log') -RedirectStandardError (Join-Path $stateDirectory 'gateway-stderr.log') -PassThru
try {
    [ordered]@{ pid = $process.Id; executable = $python; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); directory = $gatewayDirectory; port = $gatewayPort } |
        ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
    $process.WaitForExit()
    exit $process.ExitCode
} finally {
    if (Test-Path -LiteralPath $recordFile) {
        $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
        if ($record.pid -eq $process.Id) { Remove-Item -LiteralPath $recordFile -Force }
    }
}
