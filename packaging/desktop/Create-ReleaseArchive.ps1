[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($SourceDirectory)
$output = [System.IO.Path]::GetFullPath($OutputFile)
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Release package directory does not exist.' }
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite an existing release archive: $output" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = @(Get-ChildItem -LiteralPath $source -File -Recurse -Force | Sort-Object { $_.FullName.Substring($source.Length).ToLowerInvariant() })
  foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($source.Length).TrimStart('\', '/') -replace '\\', '/'
    $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $input = [System.IO.File]::OpenRead($file.FullName)
    try {
      $outputStream = $entry.Open()
      try { $input.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $input.Dispose() }
  }
} finally { $archive.Dispose() }
