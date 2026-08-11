param(
    [Parameter(Mandatory = $true)]
    [string]$Model,

    [string]$OutputName = "",

    [string]$ModelsRoot = "",

    [string]$HfCache = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ModelsRoot) {
    $ModelsRoot = Join-Path $repoRoot "models"
}
if (-not $HfCache) {
    $HfCache = Join-Path $repoRoot "cache\huggingface"
}

function Resolve-CommandOrPath {
    param([string[]]$Candidates)
    foreach ($candidate in $Candidates) {
        if (-not $candidate) { continue }
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    throw "Cannot find Hugging Face CLI. Install huggingface_hub or set HF_CLI to hf.exe/huggingface-cli.exe."
}

if (-not $OutputName) {
    $OutputName = ($Model -replace "[\\/]", "__")
}

$localDir = Join-Path $ModelsRoot $OutputName
New-Item -ItemType Directory -Path $ModelsRoot, $HfCache, $localDir -Force | Out-Null

$env:HF_HOME = $HfCache
$env:HUGGINGFACE_HUB_CACHE = Join-Path $HfCache "hub"

$hf = Resolve-CommandOrPath @(
    $env:HF_CLI,
    (Join-Path $repoRoot "venvs\ai311\Scripts\hf.exe"),
    (Join-Path $repoRoot "venvs\ai311\Scripts\huggingface-cli.exe"),
    "hf",
    "huggingface-cli"
)

Write-Host "Downloading $Model"
Write-Host "Target: $localDir"

& $hf download $Model --local-dir $localDir

Write-Host ""
Write-Host "Done. Local model path:"
Write-Host $localDir
