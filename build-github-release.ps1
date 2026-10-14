[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path $PSScriptRoot).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
  $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$package.version
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "Version contains unsupported characters: $Version"
}

# release-manifest.json is the single source of the release allowlist: the
# directories, root files, extra files, runtime data, robocopy excludes and the
# forceInclude rule. scripts/test/release-manifest.test.js proves that every
# tracked file is either shipped or excluded there with a reason.
$releaseManifestPath = Join-Path $projectRoot "release-manifest.json"
if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
  throw "Required release manifest is missing: release-manifest.json"
}
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($releaseManifest.schemaVersion -ne 1) {
  throw "Unsupported release-manifest.json schemaVersion: $($releaseManifest.schemaVersion)"
}
$releasePackageName = [string]$releaseManifest.packageName
if ($releasePackageName -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "release-manifest.json packageName contains unsupported characters: $releasePackageName"
}

function Get-ReleaseManifestList {
  param($Value)

  return ,@(@($Value) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
}

$releaseDirectories = Get-ReleaseManifestList $releaseManifest.directories
$runtimeDataDirectories = Get-ReleaseManifestList $releaseManifest.runtimeDataDirectories
$releaseFiles = Get-ReleaseManifestList $releaseManifest.files
$releaseExtraFiles = Get-ReleaseManifestList $releaseManifest.extraFiles
$robocopyExcludeDirs = Get-ReleaseManifestList $releaseManifest.robocopy.excludeDirs
$robocopyExcludeFiles = Get-ReleaseManifestList $releaseManifest.robocopy.excludeFiles
$forceIncludeGlobs = Get-ReleaseManifestList $releaseManifest.forceInclude

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "artifacts\github-release"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot $OutputDirectory
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$packageName = "$releasePackageName-v$Version"
$stagingRoot = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the release output directory: $fullPath"
  }
}

function ConvertTo-WindowsRelativePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return $Path.Replace('/', '\')
}

function Copy-ReleaseDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$RelativeSource,
    [string]$RelativeTarget = $RelativeSource
  )

  $source = Join-Path $projectRoot $RelativeSource
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Required release directory is missing: $RelativeSource"
  }
  $target = Join-Path $stagingRoot $RelativeTarget
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $robocopyArgs = @(
    $source,
    $target,
    "/E",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP"
  )
  if ($robocopyExcludeDirs.Count -gt 0) {
    $robocopyArgs += @("/XD") + $robocopyExcludeDirs
  }
  if ($robocopyExcludeFiles.Count -gt 0) {
    $robocopyArgs += @("/XF") + $robocopyExcludeFiles
  }
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Failed to copy release directory '$RelativeSource' (robocopy exit code $LASTEXITCODE)."
  }
}

function Copy-ReleaseFile {
  param(
    [Parameter(Mandatory = $true)][string]$RelativeSource,
    [string]$RelativeTarget = $RelativeSource
  )

  $source = Join-Path $projectRoot $RelativeSource
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required release file is missing: $RelativeSource"
  }
  $target = Join-Path $stagingRoot $RelativeTarget
  $targetParent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

# Manifest globs match forward-slash paths relative to the project root,
# ignoring case: "*" and "?" stay inside one path segment and a "**" segment
# matches any number of segments. The release-manifest test uses the same rule.
function ConvertTo-ReleaseGlobRegex {
  param([Parameter(Mandatory = $true)][string]$Glob)

  $segments = $Glob.Split('/')
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('^')
  for ($index = 0; $index -lt $segments.Count; $index++) {
    $segment = $segments[$index]
    $isLast = $index -eq ($segments.Count - 1)
    if ($segment -eq '**') {
      if ($isLast) {
        [void]$builder.Append('.*')
      } else {
        [void]$builder.Append('(?:[^/]*/)*')
      }
      continue
    }
    foreach ($character in $segment.ToCharArray()) {
      if ($character -eq [char]'*') {
        [void]$builder.Append('[^/]*')
      } elseif ($character -eq [char]'?') {
        [void]$builder.Append('[^/]')
      } else {
        [void]$builder.Append([regex]::Escape([string]$character))
      }
    }
    if (-not $isLast) {
      [void]$builder.Append('/')
    }
  }
  [void]$builder.Append('$')
  return $builder.ToString()
}

function Test-ReleasePathUnder {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$Directories = @()
  )

  foreach ($directory in $Directories) {
    $prefix = $directory.Replace('\', '/').TrimEnd('/') + '/'
    if ($Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

# Same file-name rule as the privacy check below; the release-manifest test
# keeps the two copies identical.
function Test-ReleaseForbiddenName {
  param([Parameter(Mandatory = $true)][string]$Name)

  return ($Name -eq ".env") -or
    (($Name -like ".env.*") -and ($Name -ne ".env.example")) -or
    ($Name -match '(?i)(\.pem$|\.key$|id_rsa|id_ed25519|credential|\.secret\.json$|service-api-key\.json$|\.sqlite3?(?:-(?:wal|shm))?$|\.db(?:-(?:wal|shm))?$|\.jsonl$)')
}

# Tracked plus untracked-but-not-ignored files, as forward-slash paths relative
# to the project root, or $null outside a git work tree. The output is read as
# UTF-8 so non-ASCII file names survive Windows PowerShell's console code page.
function Get-GitReleaseFiles {
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $git) {
    return $null
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $git.Path
  $startInfo.Arguments = "ls-files -z --cached --others --exclude-standard"
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $stdout = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()
  [void]$stderrTask.Result
  if ($process.ExitCode -ne 0) {
    return $null
  }
  return ,@($stdout.Split([char]0) | Where-Object { $_ } | ForEach-Object { $_.Replace('\', '/') })
}

# Fallback for an extracted release: every file under the release directories,
# skipping dependency trees.
function Get-WalkedReleaseFiles {
  param([string[]]$Directories = @())

  $files = [System.Collections.Generic.List[string]]::new()
  $pending = [System.Collections.Generic.Stack[string]]::new()
  foreach ($directory in $Directories) {
    $pending.Push($directory.Replace('\', '/').TrimEnd('/'))
  }
  while ($pending.Count -gt 0) {
    $relativeDirectory = $pending.Pop()
    $fullDirectory = Join-Path $projectRoot (ConvertTo-WindowsRelativePath $relativeDirectory)
    if (-not (Test-Path -LiteralPath $fullDirectory -PathType Container)) { continue }
    foreach ($entry in Get-ChildItem -LiteralPath $fullDirectory -Force) {
      $relativeEntry = "$relativeDirectory/$($entry.Name)"
      if ($entry.PSIsContainer) {
        if (@("node_modules", ".git") -notcontains $entry.Name) {
          $pending.Push($relativeEntry)
        }
      } else {
        $files.Add($relativeEntry)
      }
    }
  }
  return ,$files.ToArray()
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-ChildPath -Path $stagingRoot -Parent $outputRoot
Assert-ChildPath -Path $zipPath -Parent $outputRoot
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

foreach ($directory in $releaseDirectories) {
  Copy-ReleaseDirectory -RelativeSource (ConvertTo-WindowsRelativePath $directory)
}

# service-entry/data is runtime state (fleet settings and the billing database).
# Keep manager-core/data because it contains bundled public reference tables.
foreach ($relativeDataDirectory in $runtimeDataDirectories) {
  $runtimeDataPath = Join-Path $stagingRoot (ConvertTo-WindowsRelativePath $relativeDataDirectory)
  if (Test-Path -LiteralPath $runtimeDataPath) {
    Assert-ChildPath -Path $runtimeDataPath -Parent $stagingRoot
    Remove-Item -LiteralPath $runtimeDataPath -Recurse -Force
  }
}

# forceInclude is the negation rule for tracked test fixtures: a fixture that a
# robocopy exclude dropped (one under a logs\ folder or named *.log) is copied
# back. Only files inside a release directory and outside the runtime data
# directories qualify, and a name the privacy check rejects is never copied.
if ($forceIncludeGlobs.Count -gt 0) {
  $forceIncludePatterns = @($forceIncludeGlobs | ForEach-Object { ConvertTo-ReleaseGlobRegex -Glob $_ })
  $candidateFiles = Get-GitReleaseFiles
  if ($null -eq $candidateFiles) {
    $candidateFiles = Get-WalkedReleaseFiles -Directories $releaseDirectories
  }
  $forceIncludedCount = 0
  foreach ($candidate in $candidateFiles) {
    if (-not (Test-ReleasePathUnder -Path $candidate -Directories $releaseDirectories)) { continue }
    if (Test-ReleasePathUnder -Path $candidate -Directories $runtimeDataDirectories) { continue }
    $matchesForceInclude = $false
    foreach ($pattern in $forceIncludePatterns) {
      if ($candidate -match $pattern) {
        $matchesForceInclude = $true
        break
      }
    }
    if (-not $matchesForceInclude) { continue }
    $relativeCandidate = ConvertTo-WindowsRelativePath $candidate
    if (Test-Path -LiteralPath (Join-Path $stagingRoot $relativeCandidate) -PathType Leaf) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativeCandidate) -PathType Leaf)) { continue }
    if (Test-ReleaseForbiddenName -Name (Split-Path -Leaf $relativeCandidate)) {
      Write-Host "Not force-including $($candidate): the privacy check rejects this file name."
      continue
    }
    Copy-ReleaseFile -RelativeSource $relativeCandidate
    $forceIncludedCount++
  }
  if ($forceIncludedCount -gt 0) {
    Write-Host "Force-included $forceIncludedCount fixture file(s) that robocopy excludes dropped."
  }
}

foreach ($file in $releaseFiles) {
  Copy-ReleaseFile -RelativeSource (ConvertTo-WindowsRelativePath $file)
}
foreach ($file in $releaseExtraFiles) {
  Copy-ReleaseFile -RelativeSource (ConvertTo-WindowsRelativePath $file)
}

# README documentation links must survive packaging. This catches the common
# failure mode where a new guide is linked from README but omitted from the
# explicit, privacy-preserving release allowlist in release-manifest.json.
$stagedReadme = Get-Content -LiteralPath (Join-Path $stagingRoot "README.md") -Raw
$linkedDocs = [regex]::Matches($stagedReadme, '\]\((docs/[^)#?]+\.md)(?:#[^)]*)?\)') |
  ForEach-Object { $_.Groups[1].Value.Replace('/', '\') } |
  Sort-Object -Unique
foreach ($linkedDoc in $linkedDocs) {
  if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot $linkedDoc) -PathType Leaf)) {
    throw "README links a documentation file that is missing from the staged release: $linkedDoc"
  }
}

$manifest = @(
  "# Release Manifest",
  "",
  "- Package: $packageName",
  "- Built: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))",
  "- Allowlist: release-manifest.json (schemaVersion $($releaseManifest.schemaVersion))",
  "",
  "## Included",
  "",
  "- Application source for service-entry, vLLM manager, llama.cpp manager, TTS, search gateway, platform MCP, and shared manager core",
  "- User documentation, tests, GitHub Actions CI, and public deployment examples",
  "- Windows install, safe Git update, start, stop, status, test, and packaging scripts",
  "",
  "## Intentionally excluded",
  "",
  "- node_modules, models, caches, logs, runtime ledgers, databases, PID files, and test output",
  "- .env files, local secrets, machine-local proxy data, screenshots, and internal audit/work files"
)
Set-Content -LiteralPath (Join-Path $stagingRoot "RELEASE-MANIFEST.md") -Value $manifest -Encoding UTF8

$forbiddenNames = Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Where-Object {
  ($_.Name -eq ".env") -or
  (($_.Name -like ".env.*") -and ($_.Name -ne ".env.example")) -or
  ($_.Name -match '(?i)(\.pem$|\.key$|id_rsa|id_ed25519|credential|\.secret\.json$|service-api-key\.json$|\.sqlite3?(?:-(?:wal|shm))?$|\.db(?:-(?:wal|shm))?$|\.jsonl$)')
}
if ($forbiddenNames) {
  throw "Privacy check failed: forbidden file name(s) found in the staged release: $($forbiddenNames.Name -join ', ')"
}

$identityNeedles = @(
  $env:USERNAME,
  $env:COMPUTERNAME,
  $env:USERPROFILE,
  $projectRoot
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
$credentialPatterns = @(
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '\bAKIA[0-9A-Z]{16}\b',
  '\bgh[pousr]_[A-Za-z0-9]{20,}\b',
  '\bgithub_pat_[A-Za-z0-9_]{20,}\b',
  '\bsk-[A-Za-z0-9_-]{20,}\b',
  '\bxox[baprs]-[A-Za-z0-9-]{10,}\b'
)
$privacyHits = [System.Collections.Generic.List[string]]::new()
$textExtensions = @('.cmd', '.cjs', '.example', '.html', '.js', '.json', '.md', '.ps1', '.py', '.ts', '.txt', '.xml', '.yaml', '.yml')
$stagedTextFiles = Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File | Where-Object {
  ($textExtensions -contains $_.Extension.ToLowerInvariant()) -or ($_.Name -eq '.gitignore')
}
foreach ($file in $stagedTextFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if ($null -eq $content) { continue }
  foreach ($needle in $identityNeedles) {
    if ($content.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $privacyHits.Add($file.FullName.Substring($stagingRoot.Length + 1))
      break
    }
  }
  foreach ($pattern in $credentialPatterns) {
    if ($content -match $pattern) {
      $privacyHits.Add($file.FullName.Substring($stagingRoot.Length + 1))
      break
    }
  }
}
if ($privacyHits.Count -gt 0) {
  $uniqueHits = $privacyHits | Sort-Object -Unique
  throw "Privacy check failed in staged release file(s): $($uniqueHits -join ', ')"
}

Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $([System.IO.Path]::GetFileName($zipPath))" -Encoding ASCII

Write-Host "GitHub release archive created: $zipPath"
Write-Host "SHA256: $zipHash"
