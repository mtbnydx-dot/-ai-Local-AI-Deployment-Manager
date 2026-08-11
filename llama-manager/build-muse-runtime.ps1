[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$ImageTag = "local/llama.cpp:server-cuda-muse-62bf73d",
  [string]$CudaDockerArch = "120"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$MuseRevision = "62bf73d25c53b8161f8a22894d4f90c4aebbd7d0"
$RepositoryUrl = "https://github.com/ggml-org/llama.cpp.git"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BuildSourcesRoot = Join-Path $ProjectRoot "artifacts\build-sources"

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Join-Path $BuildSourcesRoot "llama.cpp-muse-62bf73d"
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

foreach ($commandName in @("git", "docker")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$commandName' was not found in PATH."
  }
}

Invoke-NativeCommand -Executable "docker" -Arguments @("version", "--format", "{{.Server.Version}}") -Description "Docker availability check"

if (Test-Path -LiteralPath $SourceRoot) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot ".git"))) {
    throw "Existing source directory is not a Git checkout: $SourceRoot. It was left unchanged; choose another -SourceRoot."
  }

  $currentRevision = (& git -C $SourceRoot rev-parse HEAD 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $currentRevision -ne $MuseRevision) {
    throw "Existing source directory is not pinned to $MuseRevision (found '$currentRevision'). It was left unchanged; choose another -SourceRoot."
  }

  $sourceChanges = (& git -C $SourceRoot status --porcelain 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not verify the source checkout status. The directory was left unchanged."
  }
  if ($sourceChanges) {
    throw "Existing source checkout has local changes. It was left unchanged; clean it yourself or choose another -SourceRoot."
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SourceRoot) | Out-Null
  $stagingRoot = "$SourceRoot.staging-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null

  Write-Host "Fetching pinned llama.cpp source into $stagingRoot"
  Invoke-NativeCommand -Executable "git" -Arguments @("-C", $stagingRoot, "init") -Description "Git initialization"
  Invoke-NativeCommand -Executable "git" -Arguments @("-C", $stagingRoot, "remote", "add", "origin", $RepositoryUrl) -Description "Git remote setup"
  Invoke-NativeCommand -Executable "git" -Arguments @("-C", $stagingRoot, "fetch", "--depth", "1", "origin", $MuseRevision) -Description "Pinned source fetch"
  Invoke-NativeCommand -Executable "git" -Arguments @("-C", $stagingRoot, "checkout", "--detach", "FETCH_HEAD") -Description "Pinned source checkout"

  $fetchedRevision = (& git -C $stagingRoot rev-parse HEAD 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $fetchedRevision -ne $MuseRevision) {
    throw "Fetched revision '$fetchedRevision' does not match $MuseRevision. Staging source was retained at $stagingRoot for inspection."
  }

  Rename-Item -LiteralPath $stagingRoot -NewName (Split-Path -Leaf $SourceRoot)
}

$Dockerfile = Join-Path $SourceRoot ".devops\cuda.Dockerfile"
if (-not (Test-Path -LiteralPath $Dockerfile -PathType Leaf)) {
  throw "Pinned checkout does not contain the expected CUDA Dockerfile: $Dockerfile"
}

$BuildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$BuildArguments = @(
  "build",
  "--target", "server",
  "--build-arg", "CUDA_DOCKER_ARCH=$CudaDockerArch",
  "--build-arg", "APP_VERSION=muse-62bf73d",
  "--build-arg", "APP_REVISION=$MuseRevision",
  "--build-arg", "BUILD_DATE=$BuildDate",
  "--tag", $ImageTag,
  "--file", $Dockerfile,
  $SourceRoot
)

Write-Host "Building $ImageTag from pinned revision $MuseRevision"
Invoke-NativeCommand -Executable "docker" -Arguments $BuildArguments -Description "Muse llama.cpp CUDA image build"

$revisionLabel = (& docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' $ImageTag 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "The image was built, but its revision label could not be inspected."
}
if ($revisionLabel -ne $MuseRevision) {
  throw "Image revision label mismatch: expected $MuseRevision, found '$revisionLabel'."
}

$imageId = (& docker image inspect --format '{{.Id}}' $ImageTag 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "The revision label is valid, but the image ID could not be inspected."
}

Write-Host "Muse runtime is ready."
Write-Host "Image:    $ImageTag"
Write-Host "Image ID: $imageId"
Write-Host "Revision: $revisionLabel"
Write-Host "Source:   $SourceRoot"
