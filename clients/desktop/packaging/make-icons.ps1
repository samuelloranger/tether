# Builds assets/icons/tether.ico and tether-256.png from the iOS app icon.
# The iOS icon is full-bleed with a small glyph; Windows icons are read at 16-48 px,
# so the art is cropped toward the glyph and given rounded corners.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$repo = Split-Path (Split-Path $root -Parent) -Parent
$source = "$repo/clients/apple/TetherIOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
$out = Join-Path $root 'assets/icons'
New-Item -ItemType Directory -Force $out | Out-Null

$art = [System.Drawing.Image]::FromFile($source)
$crop = New-Object System.Drawing.Rectangle 152, 152, 720, 720

function New-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $r = [Math]::Max(2.0, $size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    $g.SetClip($path)
    $dest = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $g.DrawImage($art, $dest, $crop, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $path.Dispose()
    $bmp
}

function Get-PngBytes($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    , $bytes
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = foreach ($s in $sizes) {
    $bmp = New-Icon $s
    if ($s -eq 256) { $bmp.Save((Join-Path $out 'tether-256.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    , (Get-PngBytes $bmp)
    $bmp.Dispose()
}
$art.Dispose()

# ICO with PNG-compressed entries (Windows Vista and later).
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $images[$i].Length
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
foreach ($png in $images) { $w.Write($png) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $out 'tether.ico'), $ico.ToArray())
$w.Dispose()
Write-Host "icons: $out"
