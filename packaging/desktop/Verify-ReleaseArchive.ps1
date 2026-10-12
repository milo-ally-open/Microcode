[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$archiveFile = [System.IO.Path]::GetFullPath($ArchivePath)
function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
if (-not (Test-Path -LiteralPath $archiveFile -PathType Leaf)) { throw 'Release archive does not exist.' }
$checksumFile = "$archiveFile.sha256"
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) { throw 'Release archive checksum sidecar does not exist.' }
$checksumLine = (Get-Content -LiteralPath $checksumFile -Raw).Trim()
if ($checksumLine -notmatch '^([0-9a-fA-F]{64})\s+(.+)$') { throw 'Release archive checksum sidecar is malformed.' }
if ($Matches[2] -ne [System.IO.Path]::GetFileName($archiveFile)) { throw 'Release archive checksum sidecar names a different file.' }
$archiveSha = Get-Sha256Hex -Path $archiveFile
if ($Matches[1].ToLowerInvariant() -ne $archiveSha) { throw 'Release archive SHA-256 does not match its checksum sidecar.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFile)
try {
  $manifestEntry = $archive.GetEntry('release-manifest.json')
  $hashEntry = $archive.GetEntry('release-manifest.sha256')
  if (-not $manifestEntry -or -not $hashEntry) { throw 'Release archive is missing its manifest or manifest checksum.' }
  $manifestStream = $manifestEntry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($manifestStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
    try { $manifestText = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $manifestStream.Dispose() }
  $hashStream = $hashEntry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($hashStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
    try { $manifestHashLine = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
  } finally { $hashStream.Dispose() }
  $expectedManifestHash = ($manifestHashLine -split '\s+')[0].ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $actualManifestHash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($manifestText))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($expectedManifestHash -notmatch '^[0-9a-f]{64}$' -or $actualManifestHash -ne $expectedManifestHash) { throw 'Release manifest checksum does not match the archive.' }
  $manifest = $manifestText | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows' -or $manifest.architecture -ne 'x64' -or $manifest.toolchain.bun -ne '1.3.14' -or $manifest.toolchain.bunArchiveSha256 -notmatch '^[0-9a-f]{64}$' -or $manifest.toolchain.bunLicenseSha256 -notmatch '^[0-9a-f]{64}$' -or $manifest.toolchain.electron -ne '44.7.0') {
    throw 'Release archive metadata does not describe the supported Windows x64 toolchain.'
  }
  $validationChecks = @(
    $manifest.minimumWindows.release -eq 'Windows 11 25H2'
    $manifest.minimumWindows.build -eq 26200
    $manifest.minimumWindows.serverRelease -eq 'Windows Server 2025'
    $manifest.minimumWindows.serverBuild -eq 26100
    $manifest.validation.packagedBackendSmoke.status -eq 'passed'
    $manifest.validation.packagedBackendSmoke.workspace -eq 'passed'
    $manifest.validation.packagedBackendSmoke.conversationSession -eq 'passed'
    $manifest.validation.packagedBackendSmoke.reviewDiff -eq 'passed'
    $manifest.validation.packagedBackendSmoke.gitBashTerminal -eq 'passed'
    $manifest.validation.packagedBackendSmoke.secretScan -eq 'passed'
    $manifest.validation.packagedBackendSmoke.orphanProcessScan -eq 'passed'
    $manifest.validation.installationUpgradeUninstallSmoke.status -eq 'passed'
    $manifest.validation.installationUpgradeUninstallSmoke.userDataPreserved -eq $true
  )
  if ($validationChecks -contains $false) {
    throw 'Release archive metadata does not contain completed packaging and installation smoke results.'
  }

  $expected = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $manifest.files) {
    $path = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($path) -or $path.Contains('\') -or $path.StartsWith('/') -or $path.Split('/') -contains '..' -or $expected.ContainsKey($path)) {
      throw 'Release manifest contains an unsafe or duplicate path.'
    }
    $expected.Add($path, $file)
  }
  if ($archive.Entries.Count -ne $expected.Count + 2) { throw 'Release archive contains extra or missing entries.' }
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -eq 'release-manifest.json' -or $entry.FullName -eq 'release-manifest.sha256') { continue }
    if (-not $expected.ContainsKey($entry.FullName)) { throw "Archive contains an unlisted file: $($entry.FullName)" }
    $record = $expected[$entry.FullName]
    if ($entry.Length -ne [long]$record.size) { throw "Archive file size mismatch: $($entry.FullName)" }
    $stream = $entry.Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose(); $stream.Dispose() }
    if ($hash -ne [string]$record.sha256) { throw "Archive file SHA-256 mismatch: $($entry.FullName)" }
  }
  Write-Output "RELEASE_ARCHIVE_INTEGRITY=passed; archive_checksum=passed; files=$($expected.Count); version=$($manifest.version); commit=$($manifest.commit)"
} finally { $archive.Dispose() }
