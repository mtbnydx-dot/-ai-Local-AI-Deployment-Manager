[CmdletBinding()]
param([string]$AiRoot, [string]$PythonExe)

$ErrorActionPreference = 'Stop'
if (-not $AiRoot) { $AiRoot = Split-Path -Parent $PSScriptRoot }
$root = (Resolve-Path -LiteralPath $AiRoot).Path
$runtime = Join-Path $root 'venvs\download-cli'
$python = Join-Path $runtime 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  if (Test-Path -LiteralPath $runtime) { throw "Incomplete environment exists at $runtime. Inspect it before retrying; no files were removed." }
  if (-not $PythonExe) {
    foreach ($candidate in @((Join-Path $root 'venvs\ai312\Scripts\python.exe'), (Join-Path $root 'venvs\ai311\Scripts\python.exe'), 'python.exe')) {
      $command = Get-Command $candidate -ErrorAction SilentlyContinue
      if ($command) { $PythonExe = $command.Source; break }
    }
  }
  if (-not $PythonExe) { throw 'Python 3.10+ is required. Pass -PythonExe with its full path.' }
  & $PythonExe -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'
  if ($LASTEXITCODE -ne 0) { throw 'Python version check failed.' }
  & $PythonExe -m venv $runtime
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated download environment.' }
}
& $python -m pip install --disable-pip-version-check --requirement (Join-Path $PSScriptRoot 'requirements-download.txt')
if ($LASTEXITCODE -ne 0) { throw 'Download CLI installation failed.' }
& $python -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Download CLI dependency check failed.' }
& (Join-Path $runtime 'Scripts\hf.exe') version
if ($LASTEXITCODE -ne 0) { throw 'Download CLI startup check failed.' }
& (Join-Path $runtime 'Scripts\modelscope.exe') download --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ModelScope CLI startup check failed.' }
Write-Host "Download CLI ready: $runtime"
Write-Host 'Restart the model managers to select this environment. Existing HF_HOME login/cache settings are preserved.'
