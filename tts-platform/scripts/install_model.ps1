[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("voxcpm2", "qwen_voice_design")]
    [string]$ModelId
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'runtime-root.ps1')
$runtimeRoot = Get-TtsRuntimeRoot
$env:TTS_RUNTIME_ROOT = $runtimeRoot
$env:HF_HOME = Join-Path $runtimeRoot "hf"
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
$uvFallback = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "hermes\bin\uv.exe" } else { "" }
$uv = if ($env:TTS_UV_EXE) { $env:TTS_UV_EXE } elseif ($uvCommand) { $uvCommand.Source } else { $uvFallback }

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Program,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE"
    }
}

function Install-Snapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Python,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $downloadCode = @'
import sys
from huggingface_hub import snapshot_download
snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])
'@
    Invoke-Checked $Python -c $downloadCode $Repository $Destination
    Set-Content -LiteralPath (Join-Path $Destination ".tts-install-complete") -Value $Repository -Encoding ascii
}

if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
}

switch ($ModelId) {
    "qwen_voice_design" {
        $python = Join-Path $runtimeRoot "envs\qwen\Scripts\python.exe"
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
            throw "The shared Qwen TTS environment is missing: $python"
        }
        if (Test-Path -LiteralPath $uv -PathType Leaf) {
            Invoke-Checked $uv pip install --python $python "hf_xet>=1.1"
        }
        $destination = Join-Path $runtimeRoot "models\Qwen3-TTS-12Hz-1.7B-VoiceDesign"
        Install-Snapshot -Python $python -Repository "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" -Destination $destination
    }
    "voxcpm2" {
        if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
            throw "uv is required to create the isolated VoxCPM environment: $uv"
        }
        $envRoot = Join-Path $runtimeRoot "envs\voxcpm"
        $python = Join-Path $envRoot "Scripts\python.exe"
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
            Invoke-Checked $uv venv $envRoot --python 3.11
        }
        Invoke-Checked $uv pip install --python $python "voxcpm" "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9" "soundfile>=0.12" "hf_xet>=1.1"
        $destination = Join-Path $runtimeRoot "models\VoxCPM2"
        Install-Snapshot -Python $python -Repository "openbmb/VoxCPM2" -Destination $destination
    }
}

Write-Host "Model installation completed: $ModelId" -ForegroundColor Green
