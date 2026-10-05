param(
    [string]$Version = (Select-String -Path "$PSScriptRoot/../crates/tether-app/Cargo.toml" -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = Split-Path (Split-Path $root -Parent) -Parent
$dist = Join-Path $root 'dist'
$release = Join-Path $root 'target/release'

if (-not $SkipBuild) {
    Push-Location $root
    cargo build --release -p tether-app
    if ($LASTEXITCODE) { throw 'cargo build failed' }
    Pop-Location
}
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null

$portable = Join-Path $dist 'Tether'
New-Item -ItemType Directory -Force "$portable/licenses" | Out-Null
$exe = if (Test-Path "$release/tether-app.exe") { "$release/tether-app.exe" } else { "$release/tether.exe" }
Copy-Item $exe "$portable/Tether.exe"
Copy-Item "$repo/LICENSE" "$portable/LICENSE.txt"
Copy-Item "$release/licenses/*" "$portable/licenses/"
Compress-Archive -Path $portable -DestinationPath (Join-Path $dist "Tether-$Version-x64-portable.zip")

$msix = Join-Path $dist 'msix'
Copy-Item $portable $msix -Recurse
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Image]::FromFile("$root/assets/icons/tether-256.png")
foreach ($logo in @{ 'Square44x44Logo.png' = 44; 'Square150x150Logo.png' = 150; 'StoreLogo.png' = 50 }.GetEnumerator()) {
    $bmp = New-Object System.Drawing.Bitmap $logo.Value, $logo.Value
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($icon, 0, 0, $logo.Value, $logo.Value)
    $bmp.Save((Join-Path $msix $logo.Key), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
$icon.Dispose()
$msixVersion = if ($Version -match '^\d+\.\d+\.\d+$') { "$Version.0" } else { $Version }
(Get-Content "$PSScriptRoot/AppxManifest.xml" -Raw).Replace('$VERSION$', $msixVersion) | Set-Content "$msix/AppxManifest.xml" -Encoding utf8

$makeappx = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin/*/x64/makeappx.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found: install the Windows 10/11 SDK' }
& $makeappx.FullName pack /d $msix /p (Join-Path $dist "Tether-$Version-x64.msix") /o
if ($LASTEXITCODE) { throw 'makeappx failed' }
Write-Host "dist: $dist"
