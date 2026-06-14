$ErrorActionPreference = "Stop"

$listenPort = 8001
$proxyScript = Join-Path $PSScriptRoot "claude-vllm-anthropic-proxy.py"
$backend = "http://127.0.0.1:8000"
$proxyBaseUrl = "http://127.0.0.1:$listenPort"

try {
    $models = Invoke-RestMethod -Uri "$backend/v1/models" -TimeoutSec 10
    $modelId = $models.data[0].id
    if ($modelId) {
        [Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", $proxyBaseUrl, "User")
        [Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "local-vllm", "User")
        [Environment]::SetEnvironmentVariable("ANTHROPIC_MODEL", $modelId, "User")
    }
} catch {
    # Keep the proxy startup best-effort even if vLLM is still warming up.
}

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    exit 0
}

Start-Process -FilePath "python" `
    -ArgumentList @($proxyScript, "--listen", "127.0.0.1", "--port", "$listenPort", "--backend", $backend) `
    -WindowStyle Hidden
