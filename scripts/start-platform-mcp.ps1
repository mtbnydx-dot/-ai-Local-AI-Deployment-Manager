[CmdletBinding()]
param(
  [string]$AiRoot,
  [string]$NodeExe = "node",
  [int]$Port = 5190
)

# Legacy wrapper kept (06 6.6): the parameters become the environment platform.cmd reads.
$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($AiRoot)) { $env:AI_ROOT = [System.IO.Path]::GetFullPath($AiRoot).TrimEnd('\') }
if ($PSBoundParameters.ContainsKey('NodeExe')) { $env:NODE_EXE = $NodeExe }
if ($PSBoundParameters.ContainsKey('Port')) { $env:PLATFORM_MCP_PORT = [string]$Port }
$platform = Join-Path (Split-Path -Parent $PSScriptRoot) 'platform.cmd'
& $platform start platform-mcp
exit $LASTEXITCODE
