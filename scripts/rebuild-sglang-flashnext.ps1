[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  # Runtime id inside manager-core/data/runtime-manifest.json (a local build entry).
  [string]$Runtime = 'sglangFlashNext',

  # Live root that holds artifacts\build-sources. Defaults to AI_ROOT, then the
  # live root two levels above a worktree, then the repository root.
  [string]$AiRoot,

  # Print the docker build command without running it.
  [switch]$DryRun,

  # Override the image tag recorded in the manifest.
  [string]$Tag
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $scriptRoot))

if ([string]::IsNullOrWhiteSpace($AiRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:AI_ROOT)) {
    $AiRoot = $env:AI_ROOT
  } elseif ((Split-Path -Leaf (Split-Path -Parent $repoRoot)) -eq 'worktrees') {
    $AiRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
  } else {
    $AiRoot = $repoRoot
  }
}
$AiRoot = [System.IO.Path]::GetFullPath($AiRoot)

$manifestScript = @"
const manifest = require(process.argv[1]);
const runtime = manifest.getRuntimeRelease(process.argv[2]);
if (!runtime) { console.error('unknown runtime: ' + process.argv[2]); process.exit(2); }
const loaded = manifest.loadRuntimeManifest();
console.log(JSON.stringify({ runtime, source: loaded.source, validation: loaded.validation }));
"@
$manifestModule = Join-Path $repoRoot 'manager-core\runtime-manifest.js'
$json = & node -e $manifestScript $manifestModule $Runtime
if ($LASTEXITCODE -ne 0) { throw "Could not read runtime '$Runtime' from the manifest." }
$info = $json | ConvertFrom-Json
# $Runtime is a [string] parameter; a differently named variable holds the object.
$release = $info.runtime
if (-not $info.validation.ok) { throw "runtime-manifest.json is invalid: $($info.validation.errors -join '; ')" }
if (-not $release.localBuild) { throw "Runtime '$Runtime' is a registry image, not a local build." }
if (-not $release.build -or -not $release.build.context) { throw "Runtime '$Runtime' has no build.context in the manifest." }

$context = Join-Path $AiRoot $release.build.context
$dockerfileName = if ($release.build.dockerfile) { $release.build.dockerfile } else { 'Dockerfile' }
$dockerfile = Join-Path $context $dockerfileName
$image = if ($Tag) { $Tag } else { $release.image }

if (-not (Test-Path -LiteralPath $context -PathType Container)) { throw "Build context is missing: $context" }
if (-not (Test-Path -LiteralPath $dockerfile -PathType Leaf)) { throw "Dockerfile is missing: $dockerfile" }

if ($release.patch -and $release.patch.files -and $release.patch.fileSha256) {
  foreach ($relative in $release.patch.files) {
    $patched = Join-Path $context $relative
    if (-not (Test-Path -LiteralPath $patched -PathType Leaf)) { throw "Patched source file is missing: $patched" }
    $hash = (Get-FileHash -LiteralPath $patched -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $release.patch.fileSha256.ToLowerInvariant()) {
      throw "Patched file hash mismatch for $relative (expected $($release.patch.fileSha256), got $hash). Refusing to build an unverified image."
    }
    Write-Host "Verified patch file: $relative"
  }
}

$buildArgs = @('build', '--tag', $image, '--file', $dockerfile)
if ($release.build.network -eq 'none') { $buildArgs += @('--network', 'none') }
if ($release.baseImage) { $buildArgs += @('--build-arg', "BASE_IMAGE=$($release.baseImage)") }
$buildArgs += $context

Write-Host "Runtime:      $Runtime ($($release.label))"
Write-Host "Image tag:    $image"
Write-Host "Base image:   $($release.baseImage)"
Write-Host "Context:      $context"
Write-Host "Dockerfile:   $dockerfile"
Write-Host "Command:      docker $($buildArgs -join ' ')"

if ($DryRun) { return }
if (-not $PSCmdlet.ShouldProcess($image, 'docker build')) { return }

& docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw "docker build failed with exit code $LASTEXITCODE" }

$imageId = (& docker image inspect $image --format '{{.Id}}').Trim()
Write-Host "Built $image ($imageId)."
Write-Host "If the base image or patch changed, update manager-core/data/runtime-manifest.json (or the config override) and rerun test-all.cmd."
