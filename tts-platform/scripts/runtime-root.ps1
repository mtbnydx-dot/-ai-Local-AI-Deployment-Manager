$script:TtsPlatformRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-TtsRuntimeRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:TTS_RUNTIME_ROOT)) {
        return [System.IO.Path]::GetFullPath($env:TTS_RUNTIME_ROOT)
    }
    $aiRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_ROOT)) {
        [System.IO.Path]::GetFullPath($env:AI_ROOT)
    } else {
        [System.IO.Path]::GetFullPath((Split-Path -Parent $script:TtsPlatformRoot))
    }
    return Join-Path $aiRoot 'tts-runtime'
}

