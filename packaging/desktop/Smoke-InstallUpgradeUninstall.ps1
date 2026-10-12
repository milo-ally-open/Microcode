[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$SmokeRoot
)

$ErrorActionPreference = 'Stop'
$package = [System.IO.Path]::GetFullPath($PackageDirectory)
$root = [System.IO.Path]::GetFullPath($SmokeRoot)
New-Item -ItemType Directory -Path $root -Force | Out-Null
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeDesktop'
if (Test-Path $uninstallKey) { throw 'An existing Microcode Desktop uninstall entry prevents an isolated installation smoke test.' }

$profile = Join-Path $root 'Windows profile with spaces'
$previousProfile = $env:USERPROFILE
$previousHome = $env:HOME
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$installPath = ''
try {
  $env:USERPROFILE = $profile
  $env:HOME = $profile
  $env:APPDATA = Join-Path $profile 'AppData/Roaming'
  $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
  New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA -Force | Out-Null
  $installScript = Join-Path $package 'Install-Microcode.ps1'
  & $installScript
  $installPath = Join-Path $env:LOCALAPPDATA 'Programs/Microcode'
  $uninstallScript = Join-Path $installPath 'Uninstall-Microcode.ps1'
  if (-not (Test-Path -LiteralPath (Join-Path $installPath 'Microcode.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $installPath 'resources/app/main.mjs') -PathType Leaf)) {
    throw 'The installation did not place the complete Electron application at the current-user target.'
  }
  if (-not (Test-Path $uninstallKey)) { throw 'The installation did not register its current-user uninstaller.' }
  $registeredPath = (Get-ItemProperty -Path $uninstallKey -Name InstallLocation).InstallLocation
  if ([System.IO.Path]::GetFullPath($registeredPath) -ne [System.IO.Path]::GetFullPath($installPath)) { throw 'The uninstaller registration points at the wrong installation.' }
  $shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Microcode.lnk'
  if (-not (Test-Path $shortcut)) { throw 'The installation did not create the Start Menu shortcut.' }

  $smokeScript = Join-Path $PSScriptRoot 'Smoke-PackagedBackend.ps1'
  & $smokeScript -Application (Join-Path $installPath 'Microcode.exe') -SmokeRoot (Join-Path $root 'backend smoke')

  $homeMarker = Join-Path $env:HOME '.microcode/sessions/preserve.marker'
  $appMarker = Join-Path $env:APPDATA 'Microcode/logs/preserve.marker'
  New-Item -ItemType Directory -Path (Split-Path -Parent $homeMarker),(Split-Path -Parent $appMarker) -Force | Out-Null
  Set-Content -LiteralPath $homeMarker -Value 'session and configuration data stays outside the application directory'
  Set-Content -LiteralPath $appMarker -Value 'recent project metadata and application logs stay outside the application directory'

  & $installScript
  if (-not (Test-Path -LiteralPath $homeMarker) -or -not (Test-Path -LiteralPath $appMarker)) { throw 'The in-place upgrade removed user data.' }
  & $uninstallScript
  if (Test-Path -LiteralPath $installPath) { throw 'Uninstall left the application directory behind.' }
  if (Test-Path $uninstallKey) { throw 'Uninstall left its current-user registry entry behind.' }
  if (Test-Path $shortcut) { throw 'Uninstall left the Start Menu shortcut behind.' }
  if (-not (Test-Path -LiteralPath $homeMarker) -or -not (Test-Path -LiteralPath $appMarker)) { throw 'Uninstall removed session or application user data.' }
  Write-Output 'INSTALL_UPGRADE_UNINSTALL_SMOKE=passed; current_user_scope=passed; path_with_spaces=passed; user_data_preserved=passed'
} finally {
  if ($installPath -and (Test-Path (Join-Path $installPath 'Uninstall-Microcode.ps1'))) {
    try { & (Join-Path $installPath 'Uninstall-Microcode.ps1') } catch { }
  }
  if (Test-Path $uninstallKey) {
    $registeredPath = (Get-ItemProperty -Path $uninstallKey -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
    if ($registeredPath -and $installPath -and [System.IO.Path]::GetFullPath($registeredPath) -eq [System.IO.Path]::GetFullPath($installPath)) {
      Remove-Item -Path $uninstallKey -Recurse -Force
    }
  }
  $env:USERPROFILE = $previousProfile
  $env:HOME = $previousHome
  $env:APPDATA = $previousAppData
  $env:LOCALAPPDATA = $previousLocalAppData
}
