[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ModelApiDomain,
    [string]$WebUiDomain = "",
    [string]$ApiKey = "",
    [string]$PublicBaseUrl = "",
    [string]$AllowedOrigins = "",
    [switch]$DryRun
)

# Prepares a public (Caddy) deployment of the model gateway:
#   * writes deploy\public\.env (domains + gateway key) without echoing the key
#   * validates the Caddyfile when caddy.exe is on PATH
#   * prints the environment service-entry must run with and the go-live checklist
# It never starts or restarts anything.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deployDir = Join-Path $root "deploy\public"
$caddyfile = Join-Path $deployDir "Caddyfile"
$envFile = Join-Path $deployDir ".env"
$keyFile = Join-Path $root "vllm-manager\logs\.last-public-service-key.txt"

function Assert-Domain([string]$value, [string]$name) {
    if ($value -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') {
        throw "$name must be a bare hostname such as models.example.com (got '$value')."
    }
}

$ModelApiDomain = $ModelApiDomain.Trim().ToLowerInvariant()
Assert-Domain $ModelApiDomain "ModelApiDomain"
if ($WebUiDomain) {
    $WebUiDomain = $WebUiDomain.Trim().ToLowerInvariant()
    Assert-Domain $WebUiDomain "WebUiDomain"
}
if (-not $PublicBaseUrl) { $PublicBaseUrl = "https://$ModelApiDomain" }
if ($PublicBaseUrl -notmatch '^https://') { throw "PublicBaseUrl must start with https:// (keys travel in the Authorization header)." }
if (-not $AllowedOrigins -and $WebUiDomain) { $AllowedOrigins = "https://$WebUiDomain" }

if (-not $ApiKey) {
    if (Test-Path -LiteralPath $keyFile) {
        $ApiKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
        Write-Host "Using the last public service key from vllm-manager\logs (not shown)."
    }
}
if (-not $ApiKey) {
    throw "No API key: pass -ApiKey or create a service key in a manager's 对外服务 page first."
}
if ($ApiKey.Length -lt 16) { throw "The API key looks too short to be a platform service key." }

$envLines = @(
    "WEBUI_DOMAIN=$(if ($WebUiDomain) { $WebUiDomain } else { 'chat.example.invalid' })",
    "MODEL_API_DOMAIN=$ModelApiDomain",
    "MODEL_GATEWAY_API_KEY=$ApiKey"
)

Write-Host ""
Write-Host "deploy\public\.env will contain:"
Write-Host "  WEBUI_DOMAIN=$($envLines[0].Split('=')[1])"
Write-Host "  MODEL_API_DOMAIN=$ModelApiDomain"
Write-Host "  MODEL_GATEWAY_API_KEY=<hidden, $($ApiKey.Length) chars>"

if (-not $DryRun) {
    [System.IO.File]::WriteAllText($envFile, (($envLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Wrote $envFile"
} else {
    Write-Host "(dry run: nothing written)"
}

$caddy = Get-Command caddy -ErrorAction SilentlyContinue
if ($caddy) {
    Write-Host ""
    Write-Host "Validating Caddyfile with $($caddy.Source)..."
    $env:WEBUI_DOMAIN = $envLines[0].Split('=')[1]
    $env:MODEL_API_DOMAIN = $ModelApiDomain
    & $caddy.Source validate --config $caddyfile --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw "Caddyfile validation failed." }
    Write-Host "Caddyfile is valid."
} else {
    Write-Host ""
    Write-Host "caddy.exe not on PATH; skipped 'caddy validate'. Install Caddy and rerun, or run: caddy validate --config deploy\public\Caddyfile --adapter caddyfile"
}

$caddyText = Get-Content -LiteralPath $caddyfile -Raw
if ($caddyText -notmatch '@gateway path /gateway/\*') {
    Write-Warning "The Caddyfile does not restrict the model API domain to /gateway/*; regenerate it from the repository."
}

Write-Host ""
Write-Host "Before starting the entry, set (setx or in the launching shell):"
Write-Host "  SERVICE_ENTRY_REQUIRE_API_KEY=1"
Write-Host "  SERVICE_ENTRY_PUBLIC_BASE_URL=$PublicBaseUrl"
if ($AllowedOrigins) { Write-Host "  SERVICE_ENTRY_ALLOWED_ORIGINS=$AllowedOrigins" }
Write-Host "  SERVICE_ENTRY_ALLOW_LAN_ADMIN=0"
Write-Host ""
Write-Host "Go-live checklist (the entry page shows the same list live):"
Write-Host "  [ ] Manager 对外服务 page requires the same API key"
Write-Host "  [ ] Router/firewall: only 80/443 open; 5176/5177/5178/5180/5190/7000 closed"
Write-Host "  [ ] Caddy started from deploy\public with: caddy run --envfile .env --config Caddyfile"
Write-Host "  [ ] Entry started on loopback (start-service-entry.cmd, not 'lan')"
Write-Host "  [ ] $PublicBaseUrl/gateway/health answers 200 and $PublicBaseUrl/ answers 404"
Write-Host "  [ ] $PublicBaseUrl/gateway/status with the key lists the expected models"
