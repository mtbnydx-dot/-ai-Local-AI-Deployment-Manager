[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ModelApiDomain,
    [string]$WebUiDomain = "",
    [ValidateSet("cloudflared-token", "cloudflared-config", "caddy", "lan")][string]$Topology = "cloudflared-token",
    [switch]$Apply,
    [switch]$Overwrite,
    [switch]$DryRun
)

# Prepares a public deployment of the PUBLIC listener (port 5186), 05-public.md section 14:
#   * validates the domain and renders the deploy templates into <AI_ROOT>\config\public\
#     (untracked) with service-entry\lib\deploy-templates.js, the same renderer the
#     console wizard uses; existing files are kept unless -Overwrite is given
#   * validates the Caddyfile when caddy.exe is on PATH
#   * prints the 'platform config set' commands for the base URL and the trusted proxy;
#     with -Apply it runs them (the only settings writer), without -Apply it only prints them
# It never reads or writes keys or tunnel tokens, never touches environment variables, and
# never starts or restarts anything. Owner sequence: deploy\public\README.md.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $root "config\public"
$renderer = Join-Path $root "service-entry\lib\deploy-templates.js"

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
$baseUrl = "https://$ModelApiDomain"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is required to render the templates (see docs\getting-started.md)." }

# One line, single quotes only, so every shell passes it through unchanged.
$script = "const t=require(process.argv[1]);const a=process.argv.slice(2);(async()=>{try{const plan=t.planTemplates({topology:a[0],baseUrl:a[1],config:a[2]!=='-'?{webuiDomain:a[2]}:{}});let written=[];if(a[4]!=='1'){written=(await t.writeTemplateFiles({aiRoot:a[5],files:plan.files,overwrite:a[3]==='1'})).written}console.log(JSON.stringify({ok:true,files:plan.files.map(f=>f.name),commands:plan.commands,written}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code||'error',message:e.message,existing:e.existing||[]}));process.exitCode=1}})()"
$webUiArg = if ($WebUiDomain) { $WebUiDomain } else { "-" }
$flagOverwrite = if ($Overwrite) { "1" } else { "0" }
$flagDryRun = if ($DryRun) { "1" } else { "0" }
$raw = & $node.Source -e $script $renderer $Topology $baseUrl $webUiArg $flagOverwrite $flagDryRun $root
$result = $raw | Select-Object -Last 1 | ConvertFrom-Json
if (-not $result.ok) {
    if ($result.code -eq "template_exists") {
        throw "These files already exist in config\public: $($result.existing -join ', '). Re-run with -Overwrite to replace them."
    }
    throw "Could not render the templates ($($result.code)): $($result.message)"
}

Write-Host ""
if ($DryRun) {
    Write-Host "(dry run: nothing written) Would render into ${configDir}:"
    foreach ($name in $result.files) { Write-Host "  $name" }
} elseif ($result.written.Count -gt 0) {
    Write-Host "Wrote to ${configDir}:"
    foreach ($item in $result.written) { Write-Host "  $item" }
} else {
    Write-Host "This topology renders no files."
}

$caddyfile = Join-Path $configDir "Caddyfile"
if ($Topology -eq "caddy" -and -not $DryRun) {
    $caddy = Get-Command caddy -ErrorAction SilentlyContinue
    if ($caddy) {
        Write-Host ""
        Write-Host "Validating Caddyfile with $($caddy.Source)..."
        & $caddy.Source validate --config $caddyfile --adapter caddyfile
        if ($LASTEXITCODE -ne 0) { throw "Caddyfile validation failed." }
        Write-Host "Caddyfile is valid."
    } else {
        Write-Host ""
        Write-Host "caddy.exe not on PATH; skipped 'caddy validate'. Install Caddy and run: caddy validate --config Caddyfile --adapter caddyfile (from config\public)."
    }
}

$settingCommands = @($result.commands | Where-Object { $_ -like "platform config set *" })
Write-Host ""
if ($Apply) {
    $platformCmd = Join-Path $root "platform.cmd"
    foreach ($line in $settingCommands) {
        $parts = $line.Substring("platform config set ".Length).Split(" ")
        if ($DryRun) {
            Write-Host "(dry run) $line"
            continue
        }
        Write-Host "> $line"
        & $platformCmd config set $parts[0] $parts[1]
        if ($LASTEXITCODE -ne 0) { throw "platform config set $($parts[0]) failed." }
    }
} else {
    Write-Host "Settings are not changed without -Apply. To set them yourself, run:"
    foreach ($line in $settingCommands) { Write-Host "  $line" }
}

Write-Host ""
Write-Host "Next steps (you run these; nothing is started for you):"
foreach ($line in $result.commands | Where-Object { $_ -notlike "platform config set *" }) { Write-Host "  $line" }
Write-Host ""
Write-Host "Go-live checklist (owner sequence, deploy\public\README.md):"
Write-Host "  [ ] Point the tunnel or the router at $baseUrl -> the PUBLIC listener (port 5186) only"
Write-Host "  [ ] Run the external probe in the console wizard and confirm viaProxy and the observed header"
Write-Host "  [ ] Create keys in the console (Access); the platform shows each secret once"
Write-Host "  [ ] Watch direct_manager_gateway events drop to zero, then switch the managers to enforce"
Write-Host "  [ ] Act on the legacy findings yourself; the platform never deletes or stops them"
