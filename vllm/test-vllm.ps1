param(
    [string]$Model = "",
    [int]$Port = 8000,
    [string]$Prompt = "Reply with exactly: vLLM OK"
)

$ErrorActionPreference = "Stop"

if (-not $Model) {
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 10
    $Model = $models.data[0].id
}

$body = @{
    model = $Model
    messages = @(
        @{
            role = "user"
            content = $Prompt
        }
    )
    temperature = 0
    max_tokens = 128
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/v1/chat/completions" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
    -TimeoutSec 120 |
    ConvertTo-Json -Depth 8
