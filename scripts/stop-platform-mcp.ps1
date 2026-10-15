[CmdletBinding()]
param(
  [string]$AiRoot,
  [int]$Port = 5190
)

# Legacy wrapper kept (06 6.6): the parameters become the environment platform.cmd reads.
$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($AiRoot)) { $env:AI_ROOT = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\') }
if ($PSBoundParameters.ContainsKey('Port')) { $env:PLATFORM_MCP_PORT = [string]$Port }
$platform = Join-Path (Split-Path -Parent $PSScriptRoot) 'platform.cmd'
& $platform stop platform-mcp
exit $LASTEXITCODE
