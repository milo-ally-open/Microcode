[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SetupExecutable,
  [Parameter(Mandatory = $true)][string]$SmokeRoot,
  [Parameter(Mandatory = $true)][string]$SmokeId,
  [Parameter(Mandatory = $true)][string]$SmokeStartMenuPath,
  [Parameter(Mandatory = $true)][string]$SmokeDesktopPath,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$ProductVersion
)

$ErrorActionPreference = 'Stop'
if ($SmokeId -notmatch '^[0-9a-f]{12}$') { throw 'The smoke-test installation ID is invalid.' }
$root = [System.IO.Path]::GetFullPath($SmokeRoot).TrimEnd('\') + '\'
$rootInstallPath = Join-Path ([System.IO.Path]::GetPathRoot($root)) "Microcode Setup Smoke $SmokeId"
$installPath = [System.IO.Path]::GetFullPath($InstallDirectory)
$driveRootParentSmoke = 'skipped_unwritable'
$startMenuPath = [System.IO.Path]::GetFullPath($SmokeStartMenuPath)
$desktopPath = [System.IO.Path]::GetFullPath($SmokeDesktopPath)
if (-not $installPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not $startMenuPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not $desktopPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The installer smoke-test paths must remain inside their isolated temporary root.'
}
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeSmoke-$SmokeId"
$settingsKey = "HKCU:\Software\Microcode\Smoke-$SmokeId"
if (Test-Path $uninstallKey) { throw 'A matching isolated uninstall registry entry already exists.' }
if (Test-Path $settingsKey) { throw 'A matching isolated setup registry entry already exists.' }
if (Test-Path -LiteralPath $startMenuPath) { throw 'A matching isolated Start Menu folder already exists.' }
New-Item -ItemType Directory -Path $SmokeRoot -Force | Out-Null

$profile = Join-Path $SmokeRoot 'Windows profile with spaces'
$previousProfile = $env:USERPROFILE
$previousHome = $env:HOME
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$previousNoDialog = $env:MICROCODE_SETUP_NO_DIALOG
$previousNoLaunch = $env:MICROCODE_SETUP_NO_LAUNCH
try {
  $env:USERPROFILE = $profile
  $env:HOME = $profile
  $env:APPDATA = Join-Path $profile 'AppData/Roaming'
  $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
  New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA,$desktopPath -Force | Out-Null
  $env:MICROCODE_SETUP_NO_DIALOG = '1'
  $env:MICROCODE_SETUP_NO_LAUNCH = '1'

  $setupLog = Join-Path $env:TEMP "Microcode-Setup-$ProductVersion.log"
  $arguments = '/S /D=' + $installPath
  $setup = Start-Process -FilePath $SetupExecutable -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $SetupExecutable) -WindowStyle Hidden -PassThru -Wait
  if ($setup.ExitCode -ne 0) {
    $diagnostic = if (Test-Path -LiteralPath $setupLog) { (Get-Content -LiteralPath $setupLog -Tail 80) -join "`n" } else { '' }
    throw "The NSIS setup wizard failed to install (exit code $($setup.ExitCode)).$([Environment]::NewLine)$diagnostic"
  }
  foreach ($requiredFile in @('Microcode.exe','resources/app/main.mjs','resources/microcode.ico','Uninstall Microcode.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installPath $requiredFile) -PathType Leaf)) { throw "The NSIS install omitted a required product file: $requiredFile" }
  }
  if (-not (Test-Path $uninstallKey)) { throw 'The NSIS setup did not register its current-user uninstaller.' }
  if (-not (Test-Path $settingsKey)) { throw 'The NSIS setup did not remember the chosen install directory.' }
  $registeredPath = (Get-ItemProperty -Path $uninstallKey -Name InstallLocation).InstallLocation
  if ([System.IO.Path]::GetFullPath($registeredPath) -ne $installPath) { throw 'The uninstaller registration points at the wrong selected directory.' }
  $uninstallCommand = (Get-ItemProperty -Path $uninstallKey -Name UninstallString).UninstallString
  if ($uninstallCommand -notmatch 'Uninstall Microcode\.exe') { throw 'The Apps and Features entry does not point at the branded NSIS uninstaller.' }
  $shortcut = Join-Path $startMenuPath 'Microcode.lnk'
  if (-not (Test-Path -LiteralPath $shortcut)) { throw 'The NSIS setup did not create its isolated Start Menu shortcut.' }
  if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'Microcode.lnk'))) { throw 'The NSIS setup did not create its isolated Desktop shortcut.' }

  $smokeScript = Join-Path $PSScriptRoot 'Smoke-PackagedBackend.ps1'
  & $smokeScript -Application (Join-Path $installPath 'Microcode.exe') -SmokeRoot (Join-Path $SmokeRoot 'backend smoke')

  $homeMarker = Join-Path $env:HOME '.microcode/sessions/preserve.marker'
  $appMarker = Join-Path $env:APPDATA 'Microcode/logs/preserve.marker'
  New-Item -ItemType Directory -Path (Split-Path -Parent $homeMarker),(Split-Path -Parent $appMarker) -Force | Out-Null
  Set-Content -LiteralPath $homeMarker -Value 'sessions and configuration remain outside the application directory'
  Set-Content -LiteralPath $appMarker -Value 'desktop settings and logs remain outside the application directory'

  $upgrade = Start-Process -FilePath $SetupExecutable -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $SetupExecutable) -WindowStyle Hidden -PassThru -Wait
  if ($upgrade.ExitCode -ne 0) { throw "The NSIS setup wizard failed to upgrade in place (exit code $($upgrade.ExitCode))." }
  if (-not (Test-Path -LiteralPath $homeMarker) -or -not (Test-Path -LiteralPath $appMarker)) { throw 'The in-place upgrade removed user data.' }
  if (-not (Test-Path -LiteralPath $shortcut) -or -not (Test-Path $uninstallKey)) { throw 'The in-place upgrade removed its Start Menu or uninstaller registration.' }

  $uninstaller = Join-Path $installPath 'Uninstall Microcode.exe'
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WorkingDirectory $installPath -WindowStyle Hidden -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "The NSIS uninstaller failed (exit code $($uninstall.ExitCode))." }
  if (Test-Path -LiteralPath (Join-Path $installPath 'Microcode.exe')) { throw 'The NSIS uninstaller left the application executable behind.' }
  if (Test-Path $uninstallKey) { throw 'The NSIS uninstaller left its current-user registry entry behind.' }
  if (Test-Path $settingsKey) { throw 'The NSIS uninstaller left its install-location registry setting behind.' }
  if (Test-Path -LiteralPath $shortcut) { throw 'The NSIS uninstaller left its Start Menu shortcut behind.' }
  if (Test-Path -LiteralPath (Join-Path $desktopPath 'Microcode.lnk')) { throw 'The NSIS uninstaller left its Desktop shortcut behind.' }
  if (Test-Path -LiteralPath $installPath) { throw 'The NSIS uninstaller left files in the selected install directory.' }
  if (-not (Test-Path -LiteralPath $homeMarker) -or -not (Test-Path -LiteralPath $appMarker)) { throw 'The NSIS uninstaller removed sessions, settings, or logs.' }

  if (Test-Path -LiteralPath $rootInstallPath) { throw 'A matching drive-root installer smoke directory already exists.' }
  $rootWritable = $false
  try {
    New-Item -ItemType Directory -Path $rootInstallPath -ErrorAction Stop | Out-Null
    Remove-Item -LiteralPath $rootInstallPath -Force -ErrorAction Stop
    $rootWritable = $true
  } catch {
    if (Test-Path -LiteralPath $rootInstallPath) { Remove-Item -LiteralPath $rootInstallPath -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($rootWritable) {
    $packageInstaller = Join-Path ([System.IO.Path]::GetFullPath($PackageDirectory)) 'Install-Microcode.ps1'
    if (-not (Test-Path -LiteralPath $packageInstaller -PathType Leaf)) { throw 'The release package is missing its PowerShell installer.' }
    $stagePath = "$rootInstallPath.new-$PID"
    $backupPath = "$rootInstallPath.previous-$PID"
    try {
      & $packageInstaller -InstallRoot $rootInstallPath -InstallerManaged
      if (-not (Test-Path -LiteralPath (Join-Path $rootInstallPath 'Microcode.exe') -PathType Leaf)) { throw 'The drive-root install smoke did not create Microcode.exe.' }
      $driveRootParentSmoke = 'passed'
    } finally {
      foreach ($path in @($rootInstallPath, $stagePath, $backupPath)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
      }
    }
  }
  Write-Output "NSIS_INSTALL_UPGRADE_UNINSTALL_SMOKE=passed; custom_directory=passed; path_with_spaces=passed; drive_root_parent=$driveRootParentSmoke; current_user_scope=passed; user_data_preserved=passed"
} finally {
  if (Test-Path -LiteralPath (Join-Path $installPath 'Uninstall Microcode.exe')) {
    try { Start-Process -FilePath (Join-Path $installPath 'Uninstall Microcode.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait | Out-Null } catch { }
  }
  if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -Path $uninstallKey -Recurse -Force }
  if (Test-Path -LiteralPath $settingsKey) { Remove-Item -Path $settingsKey -Recurse -Force }
  if (Test-Path -LiteralPath $startMenuPath) { Remove-Item -LiteralPath $startMenuPath -Recurse -Force }
  if (Test-Path -LiteralPath $desktopPath) { Remove-Item -LiteralPath $desktopPath -Recurse -Force }
  if (Test-Path -LiteralPath $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force }
  $env:USERPROFILE = $previousProfile
  $env:HOME = $previousHome
  $env:APPDATA = $previousAppData
  $env:LOCALAPPDATA = $previousLocalAppData
  if ($null -eq $previousNoDialog) { Remove-Item Env:MICROCODE_SETUP_NO_DIALOG -ErrorAction SilentlyContinue }
  else { $env:MICROCODE_SETUP_NO_DIALOG = $previousNoDialog }
  if ($null -eq $previousNoLaunch) { Remove-Item Env:MICROCODE_SETUP_NO_LAUNCH -ErrorAction SilentlyContinue }
  else { $env:MICROCODE_SETUP_NO_LAUNCH = $previousNoLaunch }
}
