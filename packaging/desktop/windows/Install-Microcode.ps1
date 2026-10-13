[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs/Microcode'),
  [switch]$InstallerManaged
)

$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$installPath = [System.IO.Path]::GetFullPath($InstallRoot)
$packagePrefix = $packageRoot.TrimEnd('\') + '\'
function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
if ($installPath.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $packageRoot.StartsWith($installPath.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'InstallRoot must be outside the extracted release package.'
}
if ([System.IO.Path]::GetPathRoot($installPath).TrimEnd('\') -eq $installPath.TrimEnd('\')) { throw 'InstallRoot may not be a filesystem root.' }
if (Test-Path -LiteralPath $installPath) {
  $destination = Get-Item -LiteralPath $installPath -Force
  if (-not $destination.PSIsContainer) { throw 'InstallRoot already exists and is not a directory.' }
  if (($destination.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'InstallRoot may not be a reparse point.' }
  if (@(Get-ChildItem -LiteralPath $installPath -Force).Count -gt 0) {
    $existingManifestPath = Join-Path $installPath 'release-manifest.json'
    $existingExecutable = Join-Path $installPath 'Microcode.exe'
    if (-not (Test-Path -LiteralPath $existingManifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $existingExecutable -PathType Leaf)) {
      throw 'InstallRoot is not an existing Microcode installation; choose an empty folder.'
    }
    $existingManifest = Get-Content -LiteralPath $existingManifestPath -Raw | ConvertFrom-Json
    if ($existingManifest.product -ne 'Microcode' -or $existingManifest.platform -ne 'windows') {
      throw 'InstallRoot does not contain a recognized Microcode Desktop installation.'
    }
  }
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'Microcode Desktop requires 64-bit Windows.'
}
$productOptions = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\ProductOptions')
$productType = if ($productOptions) { [string]$productOptions.GetValue('ProductType') } else { '' }
if ($productOptions) { $productOptions.Dispose() }
$osBuild = [Environment]::OSVersion.Version.Build
$isWorkstation = $productType -eq 'WinNT'
if (($isWorkstation -and $osBuild -lt 26200) -or (-not $isWorkstation -and $osBuild -lt 26100)) {
  throw 'Microcode Desktop requires Windows 11 25H2 (build 26200) or Windows Server 2025 (build 26100), x64.'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'Microcode.exe') -PathType Leaf)) { throw 'The release package is incomplete: Microcode.exe is missing.' }
$desktopExecutable = [System.IO.Path]::GetFullPath((Join-Path $installPath 'Microcode.exe'))
$desktopIsRunning = $false
foreach ($process in [System.Diagnostics.Process]::GetProcessesByName('Microcode')) {
  try {
    if ([string]::Equals([System.IO.Path]::GetFullPath($process.MainModule.FileName), $desktopExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
      $desktopIsRunning = $true
    }
  } catch {
    # Another process named Microcode can be the CLI, which is independent of the desktop install.
  } finally {
    $process.Dispose()
  }
}
if ($desktopIsRunning) { throw 'Close Microcode Desktop before installing or upgrading.' }

$packageRootItem = Get-Item -LiteralPath $packageRoot -Force
if (($packageRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The release package directory may not be a reparse point.' }
$manifestPath = Join-Path $packageRoot 'release-manifest.json'
$manifestHashPath = Join-Path $packageRoot 'release-manifest.sha256'
foreach ($metadataPath in @($manifestPath, $manifestHashPath)) {
  $metadataFile = Get-Item -LiteralPath $metadataPath -Force
  if (($metadataFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $metadataFile.PSIsContainer) { throw 'Release metadata may not be missing or linked.' }
}
$manifestHashLine = (Get-Content -LiteralPath $manifestHashPath -Raw).Trim()
$expectedManifestHash = ($manifestHashLine -split '\s+')[0].ToLowerInvariant()
$actualManifestHash = Get-Sha256Hex -Path $manifestPath
if ($expectedManifestHash -notmatch '^[0-9a-f]{64}$' -or $expectedManifestHash -ne $actualManifestHash) { throw 'The release manifest failed its SHA-256 check.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'Microcode' -or $manifest.platform -ne 'windows' -or $manifest.architecture -ne 'x64') {
  throw 'This installer does not contain a supported Microcode Windows x64 release.'
}

$expectedPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest.files) {
  $relative = [string]$entry.path
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..') {
    throw 'The release manifest contains an unsafe file path.'
  }
  $filePath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot ($relative -replace '/', '\')))
  if (-not $filePath.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'A release file escapes the package directory.' }
  $file = Get-Item -LiteralPath $filePath -Force
  if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.PSIsContainer) {
    throw "Release package entry is missing or linked: $relative"
  }
  $hash = Get-Sha256Hex -Path $filePath
  if ($hash -ne [string]$entry.sha256 -or $file.Length -ne [long]$entry.size) { throw "Release package integrity check failed: $relative" }
  if (-not $expectedPaths.Add($relative)) { throw "The release manifest contains a duplicate file: $relative" }
}
$packageEntries = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force)
foreach ($entry in $packageEntries) {
  if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The release package may not contain reparse points.' }
  if (-not $entry.FullName.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'A release package entry escapes the package directory.' }
}
$actualPaths = @($packageEntries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
  $relative = $_.FullName.Substring($packageRoot.Length).TrimStart('\', '/') -replace '\\', '/'
  if ($relative -ne 'release-manifest.json' -and $relative -ne 'release-manifest.sha256') { $relative }
})
if ($actualPaths.Count -ne $expectedPaths.Count) { throw 'The release package contains unlisted or missing files.' }
foreach ($relative in $actualPaths) { if (-not $expectedPaths.Contains($relative)) { throw "The release package contains an unlisted file: $relative" } }

$parent = Split-Path -Parent $installPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$stage = "$installPath.new-$PID"
$backup = "$installPath.previous-$PID"
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $backup)) { throw 'A previous installation staging directory needs inspection before retrying.' }
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    $sourcePath = Join-Path $packageRoot ($relative -replace '/', '\')
    $destinationPath = [System.IO.Path]::GetFullPath((Join-Path $stage ($relative -replace '/', '\')))
    if (-not $destinationPath.StartsWith(($stage.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'A release entry escapes the installation staging directory.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
  }
  Copy-Item -LiteralPath $manifestPath -Destination $stage
  Copy-Item -LiteralPath $manifestHashPath -Destination $stage

  if (Test-Path -LiteralPath $installPath) { Move-Item -LiteralPath $installPath -Destination $backup }
  try { Move-Item -LiteralPath $stage -Destination $installPath }
  catch {
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $installPath }
    throw
  }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }

  if (-not $InstallerManaged) {
    $startMenu = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    $shortcutPath = Join-Path $startMenu 'Microcode.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $installPath 'Microcode.exe'
    $shortcut.WorkingDirectory = $installPath
    $shortcut.Description = 'Microcode Desktop'
    $shortcut.Save()

    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeDesktop'
    New-Item -Path $uninstallKey -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayName -Value 'Microcode Desktop' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value ([string]$manifest.version) -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $installPath -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayIcon -Value (Join-Path $installPath 'Microcode.exe') -PropertyType String -Force | Out-Null
    $uninstaller = Join-Path $installPath 'Uninstall-Microcode.ps1'
    New-ItemProperty -Path $uninstallKey -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstaller`"" -PropertyType String -Force | Out-Null
  }
  Write-Output "Installed Microcode Desktop $($manifest.version) for the current user at $installPath"
  Write-Output 'User sessions, settings, and credentials are stored outside the install folder and are preserved.'
} catch {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  throw
}
