param(
    [string]$ContainerName = "vllm-local"
)

$docker = $env:DOCKER_EXE
if (-not $docker) {
    $docker = "docker"
}

$existing = & $docker ps -a --filter "name=^/${ContainerName}$" --format "{{.Names}}" 2>$null
if ($existing -contains $ContainerName) {
    & $docker rm -f $ContainerName
} else {
    Write-Host "No container named $ContainerName"
}
