param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$failures = @()

$zip = Join-Path $dist "Tether-$Version-x64-portable.zip"
if (-not (Test-Path $zip)) { $failures += "missing $zip" } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $entries = [IO.Compression.ZipFile]::OpenRead($zip).Entries.FullName -replace '\\', '/'
    foreach ($want in 'Tether/Tether.exe', 'Tether/LICENSE.txt', 'Tether/licenses/TerminalThemes-LICENSE.txt',
                      'Tether/licenses/Fonts-LICENSES.md', 'Tether/licenses/CascadiaCode-LICENSE.txt') {
        if ($entries -notcontains $want) { $failures += "zip lacks $want" }
    }
}

$manifest = Join-Path $dist 'msix/AppxManifest.xml'
if (-not (Test-Path $manifest)) { $failures += "missing $manifest" } else {
    [xml]$x = Get-Content $manifest -Raw
    $ns = @{ m = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' }
    $identity = (Select-Xml -Xml $x -XPath '/m:Package/m:Identity' -Namespace $ns).Node
    $msixVersion = if ($Version -match '^\d+\.\d+\.\d+$') { "$Version.0" } else { $Version }
    if ($identity.Version -ne $msixVersion) { $failures += "manifest version $($identity.Version), expected $msixVersion" }
    if ($identity.ProcessorArchitecture -ne 'x64') { $failures += 'manifest is not x64' }
    $min = (Select-Xml -Xml $x -XPath '//m:TargetDeviceFamily' -Namespace $ns).Node.MinVersion
    if ($min -ne '10.0.19045.0') { $failures += "MinVersion $min, expected 10.0.19045.0 (Windows 10 22H2)" }
    foreach ($logo in 'Square44x44Logo.png', 'Square150x150Logo.png', 'StoreLogo.png', 'Tether.exe') {
        if (-not (Test-Path (Join-Path $dist "msix/$logo"))) { $failures += "msix layout lacks $logo" }
    }
}
if (-not (Get-ChildItem $dist -Filter "Tether-$Version-x64.msix" -ErrorAction SilentlyContinue)) {
    $failures += "missing Tether-$Version-x64.msix"
}

if ($failures) { $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }; exit 1 }
Write-Host "package OK: $Version"
