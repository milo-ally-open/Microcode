[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installPath = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ([System.IO.Path]::GetFileName($installPath) -ne 'Microcode' -or -not (Test-Path (Join-Path $installPath 'Microcode.exe')) -or -not (Test-Path (Join-Path $installPath 'release-manifest.json'))) {
  throw 'Refusing to uninstall from an unexpected directory.'
}
$desktopExecutable = [System.IO.Path]::GetFullPath((Join-Path $installPath 'Microcode.exe'))
$desktopIsRunning = $false
foreach ($process in [System.Diagnostics.Process]::GetProcessesByName('Microcode')) {
  try {
    if ([string]::Equals([System.IO.Path]::GetFullPath($process.MainModule.FileName), $desktopExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
      $desktopIsRunning = $true
    }
  } catch {
    # Another process named Microcode can be the CLI, which is independent of this desktop install.
  } finally {
    $process.Dispose()
  }
}
if ($desktopIsRunning) { throw 'Close Microcode Desktop before uninstalling it.' }

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeDesktop'
if (Test-Path $uninstallKey) {
  $registeredPath = (Get-ItemProperty -Path $uninstallKey -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
  if ($registeredPath -and [System.IO.Path]::GetFullPath($registeredPath) -ne $installPath) {
    throw 'The registered Microcode install path does not match this uninstall location.'
  }
  Remove-Item -Path $uninstallKey -Recurse -Force
}

$shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Microcode.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
Remove-Item -LiteralPath $installPath -Recurse -Force
Write-Output 'Microcode Desktop was uninstalled. Sessions, settings, logs, and Windows credentials were preserved.'
