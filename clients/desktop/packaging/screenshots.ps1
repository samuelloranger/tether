# Captures every screen of a debug build against throwaway sample data, for UI review.
#   pwsh packaging/screenshots.ps1 -Out <dir> [-Pages home,keys] [-Theme <theme id>]  (dark and light alias tether and tether-light) [-Size 1040x680]
# Opening machines dials the sample hosts: "Offline" (127.0.0.1:1) gives Couldn't connect, and
# -RefusedHost host:port is pinned to a wrong key so it shows Host key refused without signing in.
param(
    [Parameter(Mandatory)][string]$Out,
    [string[]]$Pages = @('home', 'home-empty', 'keys', 'add-server', 'edit-server', 'key-generate', 'key-import',
        'key-paste', 'settings', 'schemes', 'fonts', 'remove-machine', 'delete-key', 'couldnt-connect', 'refused'),
    [string]$Theme = 'dark',
    [string]$Size = '1040x680',
    [string]$RefusedHost = '',
    [int]$Wait = 4,
    # 'terminal' opens this machine from the real data dir: it signs in and attaches.
    [string]$TerminalMachine = '',
    # "x,y" in screenshot pixels: clicked after the first capture, then captured again as <page>-clicked.
    [string]$Click = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'target/debug/tether.exe'
if (-not (Test-Path $exe)) { throw "build first: cargo build -p tether-app" }
New-Item -ItemType Directory -Force $Out | Out-Null

Add-Type -AssemblyName System.Drawing
# Raw GDI here so the C# needs no System.Drawing reference; PowerShell wraps the HBITMAP.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Snap {
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
    // x, y are in screenshot pixels: relative to the window rect, as the PNGs show it.
    public static void Click(IntPtr h, int x, int y) {
        RECT r; GetWindowRect(h, out r);
        SetForegroundWindow(h);
        SetCursorPos(r.L + x, r.T + y);
        mouse_event(2, 0, 0, 0, IntPtr.Zero);
        mouse_event(4, 0, 0, 0, IntPtr.Zero);
    }
    public static IntPtr Capture(IntPtr h) {
        RECT r; GetWindowRect(h, out r);
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr bmp = CreateCompatibleBitmap(screen, r.R - r.L, r.B - r.T);
        IntPtr old = SelectObject(mem, bmp);
        PrintWindow(h, mem, 2);
        SelectObject(mem, old);
        DeleteDC(mem);
        ReleaseDC(IntPtr.Zero, screen);
        return bmp;
    }
}
'@

$ed = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIQX3ZoKdMDkc5uiHYcnREyuBweURJDI29vRbwE+Kn6/ laptop'
$rsa = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDFSAs0dakiE+ogoJVfsEe9lJtrIDsGvTjbtX333BipdEfGqZr7p8hdsfm+9K5iGFjC3jB6pmClznH1GDAEnKurkin5e+D1KCKiwmS4NPlzGOkWufoh1GeBm4CPTSwrVWq9PkXuli8z91eFw8uXt4OhT0kug5NgNz9NPut5YGDnWVMjeh588f+TBFn1Y/1IDVvSpaXVir7LqP1XVRFZlXb/ZUq7/hRbHVrL8KwKofoaiFjb3s7bxwbdb5jzCCuJGzz50g5HX/5ePFWc2oQEnAQoErY9+HQkmRLByCaHTXUfwCsxOZ6fX8VfFUReJvzaBN30EgW0wu56IcR4/xX1dHSx work'
$keyEd = '11111111-1111-4111-8111-111111111111'
$keyRsa = '22222222-2222-4222-8222-222222222222'
$refused = if ($RefusedHost) { $RefusedHost.Split(':') } else { @('192.0.2.1', '22') }

function New-SampleData([string]$dir, [bool]$empty) {
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $dir | Out-Null
    if ($empty) { return }
    $machines = @(
        @{ id = 'aaaaaaaa-0000-4000-8000-000000000001'; name = 'devbox'; host = 'devbox.local'; port = 22; user = 'sam'; auth = @{ kind = 'key'; id = $keyEd } },
        @{ id = 'aaaaaaaa-0000-4000-8000-000000000002'; name = 'Homelab'; host = $refused[0]; port = [int]$refused[1]; user = 'samuelloranger'; auth = @{ kind = 'agent' } },
        @{ id = 'aaaaaaaa-0000-4000-8000-000000000003'; name = 'Offline'; host = '127.0.0.1'; port = 1; user = 'root'; auth = @{ kind = 'agent' } },
        @{ id = 'aaaaaaaa-0000-4000-8000-000000000004'; name = 'old-vps'; host = 'vps.example.com'; port = 2222; user = 'deploy'; auth = @{ kind = 'key'; id = '33333333-3333-4333-8333-333333333333' } }
    )
    @{ machines = $machines } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $dir 'profiles.json')
    $keys = @(
        @{ id = $keyEd; name = 'laptop'; algorithm = 'ssh-ed25519'; public_line = $ed; fingerprint = 'SHA256:8Zpi+pF9V45agFQ8U8K94LzOkaACHmXfH0prkc8Ah20'; origin = 'generated'; created = 1791158400 },
        @{ id = $keyRsa; name = 'work'; algorithm = 'ssh-rsa'; public_line = $rsa; fingerprint = 'SHA256:DknoHO6doCbLjndWJUmrVTVRygkrgBJxZAc407XOl5w'; origin = 'imported'; created = 1788566400 }
    )
    @{ keys = $keys } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $dir 'keys.json')
    $pin = (1..32 | ForEach-Object { 'ab' }) -join ':'
    @{ "$($refused[0]):$($refused[1])" = $pin } | ConvertTo-Json | Set-Content (Join-Path $dir 'hostkeys.json')
}

$data = Join-Path $env:TEMP 'tether-screens-data'
foreach ($page in $Pages) {
    New-SampleData $data ($page -eq 'home-empty')
    $env:TETHER_DEV_DATA = if ($page -eq 'terminal') { '' } else { $data }
    $env:TETHER_DEV_THEME = $Theme
    $env:TETHER_DEV_SIZE = $Size
    $env:TETHER_DEV_MACHINE = ''
    $env:TETHER_DEV_PAGE = switch ($page) {
        'home-empty' { '' }
        'home' { '' }
        'couldnt-connect' { $env:TETHER_DEV_MACHINE = 'Offline'; 'open' }
        'refused' { $env:TETHER_DEV_MACHINE = 'Homelab'; 'open' }
        'terminal' { $env:TETHER_DEV_MACHINE = $TerminalMachine; 'open' }
        default { $page }
    }
    $p = Start-Process $exe -PassThru -WindowStyle Normal
    $deadline = (Get-Date).AddSeconds(15)
    while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $p.Refresh() }
    $extra = if ($page -in 'couldnt-connect', 'refused', 'terminal') { 10 } else { 0 }
    Start-Sleep -Seconds ($Wait + $extra)
    $p.Refresh()
    $bmp = [System.Drawing.Image]::FromHbitmap([Snap]::Capture($p.MainWindowHandle))
    $file = Join-Path $Out "$page-$Theme.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host $file
    if ($Click) {
        $xy = $Click.Split(',')
        [Snap]::Click($p.MainWindowHandle, [int]$xy[0], [int]$xy[1])
        Start-Sleep -Milliseconds 1500
        $bmp = [System.Drawing.Image]::FromHbitmap([Snap]::Capture($p.MainWindowHandle))
        $file = Join-Path $Out "$page-clicked-$Theme.png"
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host $file
    }
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Get-Process tether -ErrorAction SilentlyContinue | Where-Object Path -eq (Resolve-Path $exe).Path | Stop-Process -Force
    Start-Sleep -Milliseconds 300
}
Remove-Item Env:TETHER_DEV_* -ErrorAction SilentlyContinue
