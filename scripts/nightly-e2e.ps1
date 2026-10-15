[CmdletBinding()]
param(
    [string]$Root = "",
    [switch]$SkipUnitTests,
    [switch]$IncludeMcpLive,
    [switch]$StatusOnly,
    [switch]$AllowNoServing,
    [int]$KeepReports = 30,
    [switch]$Register,
    [string]$DailyAt = "03:00",
    [string]$PublicModelsUrl = "",
    [string[]]$RequiredComponents = @('entry','vllm','llama','tts','mcp','search')
)

# Nightly end-to-end check for the running platform. Writes
# artifacts\nightly\<yyyyMMdd-HHmm>.json and latest.json; exit code 1 on any failure.
#   1. test-all.cmd (unit + syntax + frontend smoke) unless -SkipUnitTests
#   2. live probes: entry, managers, TTS, MCP, search gateway, /gateway/health, /gateway/status
#   3. optional platform-mcp validate:live (-IncludeMcpLive; needs the MCP server and internet)
#   4. `platform status --json` ("platform status": readiness layers) and its serving layer
#      ("serving": at least one model answering; -AllowNoServing reports it without failing)
# -StatusOnly runs only step 4 (no unit tests, no live probes; used by the script tests).
# -Register creates a daily scheduled task.

$ErrorActionPreference = "Continue"
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path
$reportDir = Join-Path $Root "artifacts\nightly"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

if ($Register) {
    $taskName = "LocalAIPlatformNightlyE2E"
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Root `"$Root`""
    if ($SkipUnitTests) { $action += ' -SkipUnitTests' }
    if ($IncludeMcpLive) { $action += ' -IncludeMcpLive' }
    if ($PublicModelsUrl) { $action += " -PublicModelsUrl `"$PublicModelsUrl`"" }
    schtasks /Create /F /SC DAILY /ST $DailyAt /TN $taskName /TR $action | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Nightly task registration failed' }
    Write-Host "Registered scheduled task '$taskName' daily at $DailyAt."
    return
}

$started = Get-Date
$steps = @()
function Add-Step([string]$name, [bool]$ok, [string]$detail, [double]$seconds = 0, $extra = $null) {
    $step = [ordered]@{ name = $name; ok = $ok; detail = $detail; seconds = [math]::Round($seconds, 1) }
    if ($extra) { foreach ($key in $extra.Keys) { $step[$key] = $extra[$key] } }
    $script:steps += $step
    $mark = if ($ok) { "PASS" } else { "FAIL" }
    Write-Host ("[{0}] {1} {2}" -f $mark, $name, $detail)
}

function Probe([string]$name, [string]$url, [scriptblock]$check = $null) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 15
        $ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
        $detail = "HTTP $($response.StatusCode)"
        if ($ok -and $check) {
            $body = $response.Content | ConvertFrom-Json
            $verdict = & $check $body
            if ($verdict -is [string]) { $ok = $false; $detail = $verdict } else { $ok = [bool]$verdict }
        }
        Add-Step $name $ok $detail $sw.Elapsed.TotalSeconds
    } catch {
        Add-Step $name $false $_.Exception.Message $sw.Elapsed.TotalSeconds
    }
}

if (-not $StatusOnly) {
    if (-not $SkipUnitTests) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $log = Join-Path $reportDir "test-all-latest.log"
        cmd /c "`"$Root\test-all.cmd`"" *> $log
        $code = $LASTEXITCODE
        $summary = (Get-Content -LiteralPath $log -Tail 12) -join " | "
        Add-Step "test-all.cmd" ($code -eq 0) ("exit $code; " + $summary.Substring(0, [math]::Min(300, $summary.Length))) $sw.Elapsed.TotalSeconds
    }

    Probe "entry /api/status" "http://127.0.0.1:5176/api/status" { param($b) if ($b.ok -ne $true) { return "ok=false" }; $off = @($b.components.offline | Where-Object { $_ -in $RequiredComponents }); if ($off.Count) { return "offline: " + ($off -join ",") }; $true }
    Probe "vLLM manager health" "http://127.0.0.1:5177/api/manager/health"
    Probe "llama manager health" "http://127.0.0.1:5178/api/manager/health"
    Probe "TTS gateway health" "http://127.0.0.1:7000/health"
    Probe "MCP health" "http://127.0.0.1:5190/health" { param($b) $b.service -eq "local-ai-platform-mcp" }
    Probe "search gateway health" "http://127.0.0.1:5180/health" { param($b) $b.service -eq "local-ai-search-gateway" }
    if ($PublicModelsUrl) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $PublicModelsUrl -TimeoutSec 15
            $body = $response.Content | ConvertFrom-Json
            Add-Step 'public API route' ($response.StatusCode -eq 200 -and $body.object -eq 'list') "HTTP $($response.StatusCode); model-list contract"
        } catch {
            $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            Add-Step 'public API route' ($status -eq 401) $(if ($status -eq 401) { 'HTTP 401; API authentication boundary reachable' } else { "HTTP $status; $($_.Exception.Message)" })
        }
    }

    if ($IncludeMcpLive) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        Push-Location (Join-Path $Root "platform-mcp")
        try {
            $env:AI_ROOT = $Root
            $out = & npm run validate:live 2>&1
            Add-Step "platform-mcp validate:live" ($LASTEXITCODE -eq 0) (($out | Select-Object -Last 3) -join " | ") $sw.Elapsed.TotalSeconds
        } finally { Pop-Location }
    }
}

# Readiness layers (environment -> runtime -> components -> serving -> exposure) from the CLI.
# `platform status` exits 1 unless every desired component is ready; the JSON is still on stdout.
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$platformStatus = $null
try {
    $env:AI_ROOT = $Root
    $raw = & node (Join-Path $Root "scripts\platformctl.js") status --json 2>$null
    $platformStatus = ($raw -join "`n").TrimStart([char]0xFEFF) | ConvertFrom-Json
} catch { $platformStatus = $null }
if ($platformStatus -and $platformStatus.readiness) {
    $layers = @($platformStatus.readiness.layers | ForEach-Object { [ordered]@{ id = $_.id; status = $_.status; code = $_.code } })
    $layerText = ($layers | ForEach-Object { "$($_.id)=$($_.status)" }) -join ", "
    $overall = [string]$platformStatus.readiness.overall
    Add-Step "platform status" ($overall -ne "down") "overall=$overall; $layerText" $sw.Elapsed.TotalSeconds ([ordered]@{ overall = $overall; layers = $layers })
    $serving = $layers | Where-Object { $_.id -eq "serving" } | Select-Object -First 1
    if ($serving) {
        $servingOk = ($serving.status -eq "ok") -or ($AllowNoServing -and $serving.code -eq "no_model_serving")
        $count = if ($platformStatus.models) { [int]$platformStatus.models.serving } else { 0 }
        Add-Step "serving" $servingOk "serving=$($serving.status); models serving: $count$(if ($serving.code) { '; ' + $serving.code })"
    } else {
        Add-Step "serving" $false "no serving layer in the status output"
    }
} else {
    Add-Step "platform status" $false "platform status --json produced no readable output" $sw.Elapsed.TotalSeconds
    Add-Step "serving" $false "unknown: platform status unavailable"
}

$failed = @($steps | Where-Object { -not $_.ok })
$report = [ordered]@{
    startedAt = $started.ToString("o")
    finishedAt = (Get-Date).ToString("o")
    root = $Root
    ok = ($failed.Count -eq 0)
    passed = @($steps | Where-Object { $_.ok }).Count
    failed = $failed.Count
    steps = $steps
}
$stamp = $started.ToString("yyyyMMdd-HHmm")
$json = $report | ConvertTo-Json -Depth 5
Set-Content -LiteralPath (Join-Path $reportDir "$stamp.json") -Value $json -Encoding UTF8
Set-Content -LiteralPath (Join-Path $reportDir "latest.json") -Value $json -Encoding UTF8
Get-ChildItem -LiteralPath $reportDir -Filter "*.json" | Where-Object { $_.Name -match '^\d{8}-\d{4}\.json$' } |
    Sort-Object Name -Descending | Select-Object -Skip ([math]::Max(1, $KeepReports)) | Remove-Item -Force

Write-Host ""
Write-Host ("Nightly e2e: {0} passed, {1} failed -> {2}" -f $report.passed, $report.failed, (Join-Path $reportDir "$stamp.json"))
if ($failed.Count) { exit 1 }
exit 0
