[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$CacheRoot
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath($RepositoryRoot)
$cache = [System.IO.Path]::GetFullPath($CacheRoot)
$runtimeLock = Get-Content (Join-Path $repo 'packaging/desktop/windows/runtime-lock.json') -Raw | ConvertFrom-Json
function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
if (-not $cache.StartsWith($repo.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Runtime downloads must stay under the repository build output.'
}
New-Item -ItemType Directory -Path $cache -Force | Out-Null

$electronPackage = Get-Content (Join-Path $repo 'node_modules/electron/package.json') -Raw | ConvertFrom-Json
$electronVersion = [string]$electronPackage.version
$electronAsset = "electron-v$electronVersion-win32-x64.zip"
$electronChecksums = Get-Content (Join-Path $repo 'node_modules/electron/checksums.json') -Raw | ConvertFrom-Json
$electronHash = [string]$electronChecksums.PSObject.Properties[$electronAsset].Value
if ($electronVersion -ne '44.7.0' -or $electronHash -notmatch '^[0-9a-f]{64}$') {
  throw 'The pinned Electron package or its Windows checksum does not match this release configuration.'
}
$electronZip = Join-Path $cache $electronAsset
$electronDirectory = Join-Path $cache "electron-$electronVersion-win32-x64"
if (-not (Test-Path (Join-Path $electronDirectory 'electron.exe'))) {
  if (-not (Test-Path $electronZip)) {
    $electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/$electronAsset"
    & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 300 -o $electronZip $electronUrl
    if ($LASTEXITCODE -ne 0) { throw "Could not download the pinned Electron runtime (curl exit $LASTEXITCODE)." }
  }
  $actualHash = Get-Sha256Hex -Path $electronZip
  if ($actualHash -ne $electronHash) { throw 'The Electron Windows runtime failed its locked SHA-256 check.' }
  if (Test-Path $electronDirectory) { throw "Incomplete cached Electron extraction exists; inspect it before retrying: $electronDirectory" }
  New-Item -ItemType Directory -Path $electronDirectory | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($electronZip, $electronDirectory)
  if (-not (Test-Path (Join-Path $electronDirectory 'electron.exe'))) { throw 'The Electron archive did not contain electron.exe.' }
}

$bun = $runtimeLock.bun
if ($bun.version -ne '1.3.14' -or $bun.archive -ne 'bun-windows-x64.zip' -or $bun.sha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'The portable Bun runtime lock is invalid.'
}
$bunArchive = Join-Path $cache $bun.archive
$bunDirectory = Join-Path $cache "bun-$($bun.version)-windows-x64"
$bunExecutable = Join-Path $bunDirectory 'bun-windows-x64/bun.exe'
if (-not (Test-Path -LiteralPath $bunExecutable -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath $bunArchive -PathType Leaf)) {
    & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 300 -o $bunArchive $bun.download
    if ($LASTEXITCODE -ne 0) { throw "Could not download the pinned Bun runtime (curl exit $LASTEXITCODE)." }
  }
  $actualHash = Get-Sha256Hex -Path $bunArchive
  if ($actualHash -ne $bun.sha256) { throw 'The Bun Windows runtime failed its locked SHA-256 check.' }
  if (Test-Path -LiteralPath $bunDirectory) { throw "Incomplete cached Bun extraction exists; inspect it before retrying: $bunDirectory" }
  New-Item -ItemType Directory -Path $bunDirectory | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($bunArchive, $bunDirectory)
  if (-not (Test-Path -LiteralPath $bunExecutable -PathType Leaf)) { throw 'The Bun archive did not contain the expected Windows runtime.' }
}
$bunReportedVersion = (& $bunExecutable --version).Trim()
if ($LASTEXITCODE -ne 0 -or $bunReportedVersion -ne $bun.version) { throw 'The packaged Bun executable does not match the locked runtime version.' }

$git = $runtimeLock.gitForWindows
if ($git.version -ne '2.54.0.windows.1' -or $git.archive -ne 'PortableGit-2.54.0-64-bit.7z.exe' -or $git.sha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'The portable Git runtime lock is invalid.'
}
$gitArchive = Join-Path $cache $git.archive
$gitDirectory = Join-Path $cache "git-for-windows-$($git.version)-x64"
if (-not (Test-Path (Join-Path $gitDirectory 'bin/bash.exe'))) {
  if (-not (Test-Path $gitArchive)) {
    & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 300 -o $gitArchive $git.download
    if ($LASTEXITCODE -ne 0) { throw "Could not download the pinned Git for Windows runtime (curl exit $LASTEXITCODE)." }
  }
  $actualHash = Get-Sha256Hex -Path $gitArchive
  if ($actualHash -ne $git.sha256) { throw 'The Git for Windows archive failed its locked SHA-256 check.' }
  if (Test-Path $gitDirectory) { throw "Incomplete cached Git extraction exists; inspect it before retrying: $gitDirectory" }
  New-Item -ItemType Directory -Path $gitDirectory | Out-Null
  $extract = Start-Process -FilePath $gitArchive -ArgumentList @('-y', "-o`"$gitDirectory`"") -WindowStyle Hidden -PassThru -Wait
  if ($extract.ExitCode -ne 0) { throw "Portable Git extraction failed with exit code $($extract.ExitCode)." }
  if (-not (Test-Path (Join-Path $gitDirectory 'bin/bash.exe')) -or -not (Test-Path (Join-Path $gitDirectory 'cmd/git.exe'))) {
    throw 'The portable Git runtime is missing Bash or Git.'
  }
}

$nsis = $runtimeLock.nsis
if ($nsis.version -ne '3.13' -or $nsis.archive -ne 'nsis-3.13.zip' -or $nsis.sha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'The NSIS compiler lock is invalid.'
}
$nsisCache = Join-Path $cache "nsis-$($nsis.version)"
$nsisArchive = Join-Path $nsisCache $nsis.archive
$nsisDirectory = Join-Path $nsisCache "nsis-$($nsis.version)"
$nsisCompiler = Join-Path $nsisDirectory 'makensis.exe'
if (-not (Test-Path -LiteralPath $nsisCompiler -PathType Leaf)) {
  New-Item -ItemType Directory -Path $nsisCache -Force | Out-Null
  if (-not (Test-Path -LiteralPath $nsisArchive -PathType Leaf)) {
    & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 300 -o $nsisArchive $nsis.download
    if ($LASTEXITCODE -ne 0) { throw "Could not download the pinned NSIS compiler (curl exit $LASTEXITCODE)." }
  }
  $actualHash = Get-Sha256Hex -Path $nsisArchive
  if ($actualHash -ne $nsis.sha256) { throw 'The NSIS compiler archive failed its locked SHA-256 check.' }
  if (Test-Path -LiteralPath $nsisDirectory) { throw "Incomplete cached NSIS extraction exists; inspect it before retrying: $nsisDirectory" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($nsisArchive, $nsisCache)
  if (-not (Test-Path -LiteralPath $nsisCompiler -PathType Leaf)) { throw 'The NSIS archive did not contain makensis.exe.' }
}
$nsisVersionOutput = (& $nsisCompiler /VERSION | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nsisVersionOutput -notmatch '3\.13') { throw 'The downloaded NSIS compiler does not match its locked version.' }

Write-Output (ConvertTo-Json -Compress -InputObject @{
  electronVersion = $electronVersion
  electronDirectory = $electronDirectory
  electronSha256 = $electronHash
  bunVersion = [string]$bun.version
  bunExecutable = $bunExecutable
  bunArchiveSha256 = [string]$bun.sha256
  gitVersion = [string]$git.version
  gitDirectory = $gitDirectory
  gitArchiveSha256 = [string]$git.sha256
  nsisVersion = [string]$nsis.version
  nsisDirectory = $nsisDirectory
  nsisCompiler = $nsisCompiler
  nsisArchiveSha256 = [string]$nsis.sha256
})
