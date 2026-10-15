[CmdletBinding()]
param(
  [string]$AiRoot,
  [int]$Port = 5190,
  [switch]$Json
)

# Legacy wrapper kept (06 6.6): the parameters become the environment platform.cmd reads.
$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($AiRoot)) { $env:AI_ROOT = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\') }
if ($PSBoundParameters.ContainsKey('Port')) { $env:PLATFORM_MCP_PORT = [string]$Port }
$platform = Join-Path (Split-Path -Parent $PSScriptRoot) 'platform.cmd'
& $platform status platform-mcp @(if ($Json) { '--json' })
exit $LASTEXITCODE
