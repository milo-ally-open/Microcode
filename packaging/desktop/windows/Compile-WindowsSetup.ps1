[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CompilerPath,
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$UninstallFiles,
  [Parameter(Mandatory = $true)][string]$BrandIcon,
  [Parameter(Mandatory = $true)][string]$WizardBitmap,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [Parameter(Mandatory = $true)][string]$ProductVersion,
  [ValidateSet('release', 'smoke')][string]$BuildMode = 'release',
  [string]$SmokeId,
  [string]$SmokeDefaultInstallDirectory,
  [string]$SmokeStartMenuPath,
  [string]$SmokeDesktopPath
)

$ErrorActionPreference = 'Stop'
foreach ($path in @($CompilerPath, $ScriptPath, $PackageDirectory, $UninstallFiles, $BrandIcon, $WizardBitmap)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "A required Windows installer build input is missing: $path" }
}
$CompilerPath = [System.IO.Path]::GetFullPath($CompilerPath)
$ScriptPath = [System.IO.Path]::GetFullPath($ScriptPath)
$PackageDirectory = [System.IO.Path]::GetFullPath($PackageDirectory)
$UninstallFiles = [System.IO.Path]::GetFullPath($UninstallFiles)
$BrandIcon = [System.IO.Path]::GetFullPath($BrandIcon)
$WizardBitmap = [System.IO.Path]::GetFullPath($WizardBitmap)
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)
if (Test-Path -LiteralPath $OutputFile) { throw "Refusing to overwrite an existing installer: $OutputFile" }

function Quote-ProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$arguments = @(
  '/V2',
  "/DPROJECT_VERSION=$ProductVersion",
  "/DOUTPUT_FILE=$OutputFile",
  "/DPACKAGE_DIRECTORY=$PackageDirectory",
  "/DUNINSTALL_FILES=$UninstallFiles",
  "/DBRAND_ICON=$BrandIcon",
  "/DWIZARD_BITMAP=$WizardBitmap"
)
if ($BuildMode -eq 'smoke') {
  if ([string]::IsNullOrWhiteSpace($SmokeId) -or [string]::IsNullOrWhiteSpace($SmokeDefaultInstallDirectory) -or [string]::IsNullOrWhiteSpace($SmokeStartMenuPath) -or [string]::IsNullOrWhiteSpace($SmokeDesktopPath)) {
    throw 'Smoke installer builds require a unique ID, install directory, Start Menu path, and Desktop path.'
  }
  $arguments += @(
    '/DSMOKE_TEST',
    "/DSMOKE_ID=$SmokeId",
    "/DSMOKE_DEFAULT_INSTALL_DIR=$SmokeDefaultInstallDirectory",
    "/DSMOKE_START_MENU_PATH=$SmokeStartMenuPath",
    "/DSMOKE_DESKTOP_PATH=$SmokeDesktopPath"
  )
}
$arguments += $ScriptPath

$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $CompilerPath
$processInfo.WorkingDirectory = Split-Path -Parent $ScriptPath
$processInfo.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument -Value $_ }) -join ' ')
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $processInfo
if (-not $process.Start()) { throw 'Could not start the NSIS compiler.' }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
  $diagnostic = @($stderrTask.Result, $stdoutTask.Result) -join "`n"
  throw "NSIS could not build the Microcode setup executable (exit code $($process.ExitCode)).`n$($diagnostic.Trim())"
}
if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf) -or (Get-Item -LiteralPath $OutputFile).Length -le 0) {
  throw 'NSIS did not create a non-empty setup executable.'
}
Write-Output "Created NSIS Microcode setup executable: $OutputFile"
if (-not [string]::IsNullOrWhiteSpace($stdoutTask.Result)) { Write-Output $stdoutTask.Result.Trim() }
