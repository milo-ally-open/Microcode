[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$LogoPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$logoFile = [System.IO.Path]::GetFullPath($LogoPath)
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $logoFile -PathType Leaf)) { throw 'The Microcode logo image is missing.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null

function New-LogoBitmap {
  param([Parameter(Mandatory = $true)][int]$Size)
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($script:logo, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
  } finally { $graphics.Dispose() }
  return $bitmap
}

$script:logo = [System.Drawing.Image]::FromFile($logoFile)
try {
  $iconPath = Join-Path $output 'Microcode.ico'
  $iconFrames = [System.Collections.Generic.List[byte[]]]::new()
  foreach ($size in @(16, 24, 32, 48, 256)) {
    $bitmap = New-LogoBitmap -Size $size
    $stream = [System.IO.MemoryStream]::new()
    try { $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); $iconFrames.Add($stream.ToArray()) }
    finally { $stream.Dispose(); $bitmap.Dispose() }
  }
  $iconStream = [System.IO.File]::Create($iconPath)
  $writer = [System.IO.BinaryWriter]::new($iconStream)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$iconFrames.Count)
    $offset = 6 + (16 * $iconFrames.Count)
    for ($index = 0; $index -lt $iconFrames.Count; $index++) {
      $size = @(16, 24, 32, 48, 256)[$index]
      $frame = $iconFrames[$index]
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$frame.Length)
      $writer.Write([UInt32]$offset)
      $offset += $frame.Length
    }
    foreach ($frame in $iconFrames) { $writer.Write($frame) }
  } finally { $writer.Dispose(); $iconStream.Dispose() }

  $wizardPath = Join-Path $output 'Microcode-Wizard.bmp'
  $wizard = [System.Drawing.Bitmap]::new(164, 314, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($wizard)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear([System.Drawing.Color]::FromArgb(238, 245, 239))
    $card = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 255))
    $border = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(215, 229, 217), 1)
    $graphics.FillRectangle($card, 20, 42, 124, 124)
    $graphics.DrawRectangle($border, 20, 42, 123, 123)
    $graphics.DrawImage($script:logo, [System.Drawing.Rectangle]::new(28, 50, 108, 108))
    $titleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $captionFont = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $titleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(25, 38, 31))
    $captionBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(82, 105, 88))
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('Microcode', $titleFont, $titleBrush, [System.Drawing.RectangleF]::new(12, 190, 140, 26), $format)
    $graphics.DrawString('A CODING WORKSPACE', $captionFont, $captionBrush, [System.Drawing.RectangleF]::new(10, 222, 144, 18), $format)
    $graphics.DrawString('THAT THINKS WITH YOU', $captionFont, $captionBrush, [System.Drawing.RectangleF]::new(10, 238, 144, 18), $format)
    $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(215, 229, 217), 1)
    $graphics.DrawLine($linePen, 30, 273, 134, 273)
    $linePen.Dispose(); $format.Dispose(); $titleBrush.Dispose(); $captionBrush.Dispose(); $titleFont.Dispose(); $captionFont.Dispose(); $card.Dispose(); $border.Dispose()
    $wizard.Save($wizardPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $graphics.Dispose(); $wizard.Dispose() }
  Write-Output "Created Microcode installer brand assets in $output"
} finally { $script:logo.Dispose() }
