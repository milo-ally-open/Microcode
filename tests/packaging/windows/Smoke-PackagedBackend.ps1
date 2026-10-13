[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Application,
  [Parameter(Mandatory = $true)][string]$SmokeRoot
)

$ErrorActionPreference = 'Stop'
$app = [System.IO.Path]::GetFullPath($Application)
$root = [System.IO.Path]::GetFullPath($SmokeRoot)
New-Item -ItemType Directory -Path $root -Force | Out-Null
$profile = Join-Path $root 'profile with spaces'
$userData = Join-Path $profile 'Microcode user data'
$workspace = Join-Path $root 'project with spaces'
$stdoutPath = Join-Path $root 'packaged-smoke.stdout.log'
$stderrPath = Join-Path $root 'packaged-smoke.stderr.log'
$gitRoot = Join-Path (Split-Path -Parent $app) 'resources/git'
$backendExecutable = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $app) 'resources/microcode-backend.exe'))
$gitExecutable = Join-Path $gitRoot 'cmd/git.exe'
if (-not (Test-Path -LiteralPath $gitExecutable -PathType Leaf)) { throw 'The release package is missing its portable Git runtime.' }
New-Item -ItemType Directory -Path $userData,$workspace -Force | Out-Null

function Invoke-SmokeGit {
  param([Parameter(Mandatory = $true)][string[]]$GitArguments)
  $output = & $gitExecutable @GitArguments
  if ($LASTEXITCODE -ne 0) { throw 'Portable Git failed while preparing the packaged project smoke test.' }
  return $output
}

$readme = Join-Path $workspace 'README.md'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($readme, "packaged-review-before`n", $utf8)
Invoke-SmokeGit -GitArguments @('-C', $workspace, 'init', '--initial-branch=main') | Out-Null
Invoke-SmokeGit -GitArguments @('-C', $workspace, 'add', 'README.md') | Out-Null
Invoke-SmokeGit -GitArguments @('-C', $workspace, '-c', 'user.name=Microcode', '-c', 'user.email=microcode@example.invalid', 'commit', '-m', 'smoke baseline') | Out-Null
[System.IO.File]::WriteAllText($readme, "packaged-review-before`npackaged-review-after`n", $utf8)

$sentinel = 'MICROCODE_TEST_OPENAI_KEY_NEVER_LOG_7f94a2b1'
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$previousUserProfile = $env:USERPROFILE
$previousHome = $env:HOME
$previousPath = $env:PATH
$previousGitNoSystem = $env:GIT_CONFIG_NOSYSTEM
$previousOpenAiKey = $env:OPENAI_API_KEY
$process = $null
try {
  $env:USERPROFILE = $profile
  $env:HOME = $profile
  $env:APPDATA = Join-Path $profile 'AppData/Roaming'
  $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
  $env:PATH = "$($gitRoot)\cmd;$($gitRoot)\mingw64\bin;$($gitRoot)\usr\bin;$previousPath"
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:OPENAI_API_KEY = $sentinel
  New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA -Force | Out-Null
  $arguments = @('--microcode-smoke-test', "--user-data-dir=`"$userData`"", "--microcode-smoke-workspace=`"$workspace`"")
  $process = Start-Process -FilePath $app -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $app) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  if (-not $process.WaitForExit(90000)) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    throw 'Packaged application exceeded the 90 second backend and workflow smoke timeout.'
  }
  $process.Refresh()
  $stdout = if (Test-Path -LiteralPath $stdoutPath) { [System.IO.File]::ReadAllText($stdoutPath) } else { '' }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { [System.IO.File]::ReadAllText($stderrPath) } else { '' }
  if ($stdout.Contains($sentinel) -or $stderr.Contains($sentinel)) { throw 'A provider test credential appeared in packaged startup diagnostics.' }
  $logs = @([System.IO.Directory]::GetFiles($profile, '*.log', [System.IO.SearchOption]::AllDirectories))
  foreach ($log in $logs) {
    if ([System.IO.File]::ReadAllText($log).Contains($sentinel)) { throw 'A provider test credential appeared in an application log.' }
  }
  $exitCode = $process.ExitCode
  if ($null -ne $exitCode -and $exitCode -ne 0) { throw "Packaged application backend/workflow smoke failed with exit code $exitCode. See isolated diagnostics under $root." }
  $smokeFailureLine = $stderr -split '\r?\n' | Where-Object { $_ -match '^MICROCODE_DESKTOP_SMOKE_FAILED(?:\s|$)' } | Select-Object -First 1
  if ($smokeFailureLine) { throw "Packaged application reported a backend/workflow smoke failure: $($smokeFailureLine.Trim())" }

  $handshakeLine = ($stdout -split '\r?\n' | Where-Object { $_ -match '^MICROCODE_DESKTOP_SMOKE_OK ' } | Select-Object -First 1)
  if (-not $handshakeLine) { throw 'Packaged application did not report a compatible backend and protocol handshake.' }
  $handshake = $handshakeLine.Substring('MICROCODE_DESKTOP_SMOKE_OK '.Length) | ConvertFrom-Json
  if ($handshake.appVersion -ne $handshake.backendVersion -or $handshake.runtimeProtocolVersion -ne 1 -or $handshake.transportProtocolVersion -ne 1) {
    throw 'Packaged application reported incompatible app/backend versions or protocol versions.'
  }
  foreach ($workflow in @('workspace', 'conversationSession', 'reviewDiff', 'gitBashTerminal')) {
    if ($handshake.$workflow -ne 'passed') { throw "Packaged application did not pass its $workflow workflow smoke." }
  }
  if ($handshake.gitBashTerminalColors -ne 'passed') { throw 'Packaged Git Bash did not pass its ANSI color smoke.' }
  if ($handshake.openAiCodexOAuth -ne 'authorization-url-opened-and-cancelled') { throw 'Packaged OpenAI Codex OAuth did not open and cancel its browser authorization flow.' }
  if ($handshake.providerWithoutCredentials -notin @('clear-configuration-error', 'not-tested-no-unconfigured-model')) {
    throw 'Packaged application did not report a usable provider setup state.'
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  $orphanBackendProcesses = @()
  $orphanTerminalProcesses = @()
  do {
    $orphanBackendProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'microcode-backend.exe'" | Where-Object {
      $_.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $backendExecutable, [System.StringComparison]::OrdinalIgnoreCase)
    })
    $orphanTerminalProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'bash.exe'" | Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf($gitRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($orphanBackendProcesses.Count -eq 0 -and $orphanTerminalProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($orphanBackendProcesses.Count -gt 0) { throw 'The packaged backend remained running after the desktop application exited.' }
  if ($orphanTerminalProcesses.Count -gt 0) {
    foreach ($orphan in $orphanTerminalProcesses) { Stop-Process -Id $orphan.ProcessId -Force -ErrorAction SilentlyContinue }
    throw 'The packaged Bash terminal remained running after the desktop application exited.'
  }
  Write-Output ($handshakeLine.Trim())
  Write-Output 'PACKAGED_BACKEND_SMOKE=passed; project_session=passed; git_review=passed; git_bash_terminal=passed; terminal_colors=passed; openai_codex_oauth=passed; secret_scan=passed; orphan_process_scan=passed'
} finally {
  if ($process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
  $env:APPDATA = $previousAppData
  $env:LOCALAPPDATA = $previousLocalAppData
  $env:USERPROFILE = $previousUserProfile
  $env:HOME = $previousHome
  $env:PATH = $previousPath
  if ($null -eq $previousGitNoSystem) { Remove-Item Env:GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue }
  else { $env:GIT_CONFIG_NOSYSTEM = $previousGitNoSystem }
  if ($null -eq $previousOpenAiKey) { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }
  else { $env:OPENAI_API_KEY = $previousOpenAiKey }
}
