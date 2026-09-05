# Tether server installer for Windows. Resolves the latest GitHub release,
# downloads tether-windows-x64.exe, verifies its published SHA256, installs to
# %LOCALAPPDATA%\Programs\tether and puts that directory on the user PATH.
# The POSIX counterpart is install.sh and behaves the same way.
#   irm https://samlo.cloud/tether/install.ps1 | iex
#
# Options arrive as environment variables rather than a param() block: `iex`
# executes a *string*, so a piped script has no argument list to bind and the
# one-liner above could never pass a -DryRun switch. install.sh uses env vars
# for the same reason.
#   $env:TETHER_VERSION   = 'v3.1.2'    pin a version instead of "latest"
#   $env:TETHER_REPO_SLUG = 'you/fork'  install from a fork
#   $env:DRY_RUN          = '1'         print the plan and stop
#
# This file is deliberately ASCII-only. Windows PowerShell 5.1 decodes a .ps1
# without a BOM as the system ANSI codepage, and `irm` decodes a response with
# no charset the same way, so any non-ASCII character here would reach the user
# as mojibake on exactly the hosts least able to fix it.
#
# Everything lives in a function so the one-liner cannot take the caller's shell
# down with it: `exit` inside an `iex`-ed string closes the host window, while
# `return` and `throw` stay contained.
function Install-Tether {
  # Function-scoped, so piping this into an interactive session does not leave
  # the user's own preferences rewritten afterwards.
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell redraws a progress bar for every Invoke-WebRequest chunk
  # and it dominates the wall time on a ~100MB binary. Silencing it is the
  # difference between seconds and minutes.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 still negotiates TLS 1.0 by default, which
  # api.github.com refuses outright. PowerShell 7 already picks TLS 1.2+; the
  # try is for hosts where the enum member is missing.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

  $repo = if ($env:TETHER_REPO_SLUG) { $env:TETHER_REPO_SLUG } else { 'samuelloranger/tether' }
  # There is no ~/.local/bin on Windows. %LOCALAPPDATA%\Programs is where
  # per-user, non-elevated installs go (VS Code and the GitHub CLI both land
  # there), so nothing here needs an administrator prompt.
  $binDir = Join-Path $env:LOCALAPPDATA 'Programs\tether'
  $dest = Join-Path $binDir 'tether.exe'

  # PROCESSOR_ARCHITEW6432 is set only for a process running narrower than its
  # OS, and then it names the real machine - so it wins when present. Without it
  # an x64-emulated PowerShell on Windows-on-ARM would report AMD64 and get
  # handed a binary nobody has ever run there. update.ts's assetName() refuses
  # windows/arm64 for the same reason; the two must agree or `tether update`
  # would break a host this installer accepted.
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') {
    throw "Unsupported architecture: $arch. The Tether server is built for Windows x64 only - Windows on ARM is not supported."
  }

  if ($env:TETHER_VERSION) {
    $tag = $env:TETHER_VERSION
  } else {
    $headers = @{ 'User-Agent' = 'tether-installer' }
    $tag = (Invoke-RestMethod -UseBasicParsing -Headers $headers `
      -Uri "https://api.github.com/repos/$repo/releases/latest").tag_name
  }
  if (-not $tag) { throw 'Could not resolve latest release tag' }

  # Asset names are stable (un-versioned). Windows ships the raw .exe: unlike a
  # macOS Mach-O it has no exec bit or quarantine flag to lose in a download, so
  # no tarball wrapper is needed - but it does need the extension to be runnable.
  $asset = 'tether-windows-x64.exe'
  $url = "https://github.com/$repo/releases/download/$tag/$asset"

  if ($env:DRY_RUN -eq '1') {
    Write-Host "would download: $url"
    Write-Host "would install to: $dest"
    return
  }

  # Windows holds a write lock on any executable image that is mapped into a
  # running process, so a live daemon makes $dest unreplaceable. Check before
  # downloading, so the failure is one sentence instead of a sharing violation
  # after a 100MB transfer. Opening for Write with share ReadWrite is the
  # cheapest probe: it succeeds on an idle file and throws on a running one.
  if (Test-Path -LiteralPath $dest) {
    try {
      $probe = [System.IO.File]::Open(
        $dest, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $probe.Close()
    } catch {
      throw "$dest is in use by a running Tether. Stop it first:  tether stop"
    }
  }

  Write-Host "Installing tether $tag ($asset)..."
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  # Stage in a temp dir inside $binDir - same volume, so the final Move-Item is
  # a metadata rename and $dest is never a half-written file. The temp dir also
  # keeps the staged download from colliding with $dest itself.
  $tmpDir = Join-Path $binDir ('.tether-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  try {
    $dl = Join-Path $tmpDir 'tether.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dl

    # Verify against the published "<asset>.sha256" BEFORE the binary is put
    # anywhere it could be run - the checksum is the trust decision. A tampered
    # release asset or a MITM on the download fails here. The release job writes
    # this file with sha256sum, so it is "<hex>  <filename>".
    $sums = Invoke-RestMethod -UseBasicParsing -Uri "$url.sha256"
    $expected = ($sums -split '\s+' | Where-Object { $_ } | Select-Object -First 1)
    if (-not $expected) { throw "No published checksum for $asset - refusing to install." }
    # Get-FileHash reports uppercase hex, sha256sum lowercase; -ne on strings is
    # case-insensitive in PowerShell, which is what we want here.
    $actual = (Get-FileHash -LiteralPath $dl -Algorithm SHA256).Hash
    if ($actual -ne $expected) {
      throw "Checksum mismatch for $asset - aborting (possible tampering).`n  expected $expected`n  actual   $actual"
    }

    try {
      Move-Item -LiteralPath $dl -Destination $dest -Force
    } catch {
      # Lost the race with a daemon that started between the probe and here.
      throw "Could not replace $dest - is Tether running? Run 'tether stop' and re-run this installer."
    }
  } finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Installed to $dest"

  # No legacy-daemon shutdown here, unlike install.sh: the pre-binary
  # source-copy installer was POSIX-only, so there is no ~/.tether/app on
  # Windows to quiesce and migrate.

  # Put the install dir on the user PATH. This matters more than it does on
  # POSIX: coding agents run `tether signal` and `tether present` from *inside*
  # a Tether session, so a tether that is not on PATH breaks the Claude Code
  # hooks integration silently rather than loudly.
  #
  # Read and write the User scope only. $env:Path is the machine and user values
  # already merged, and writing that back into the user scope is the classic way
  # to permanently duplicate every system entry into your profile.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  $normalized = $binDir.TrimEnd('\')
  $onUserPath = @($userPath -split ';' | Where-Object { $_ } | Where-Object { $_.Trim().TrimEnd('\') -eq $normalized })
  if ($onUserPath.Count -gt 0) {
    Write-Host "PATH already includes $binDir"
  } else {
    $updated = if ($userPath.Trim()) { $userPath.TrimEnd(';') + ';' + $binDir } else { $binDir }
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    Write-Host "Added $binDir to your user PATH."
    Write-Host "Open a NEW terminal before using 'tether' elsewhere - a shell reads PATH once, at start."
  }
  # Make `tether` resolve in *this* session too, so the next-step commands below
  # can be pasted immediately rather than after a restart.
  if (@($env:Path -split ';' | Where-Object { $_.Trim().TrimEnd('\') -eq $normalized }).Count -eq 0) {
    $env:Path = "$env:Path;$binDir"
  }

  Write-Host ''
  Write-Host 'Next:  tether start'
  Write-Host '       tether pair'
  Write-Host ''
  Write-Host 'On first start Windows Defender Firewall asks whether to allow tether on the network. Allow it for the networks you connect from, or nothing but this machine can reach the server.'
  Write-Host 'SECURITY: access is per-device Noise pairing (`tether pair`). TLS is served on :8443 (self-signed, pinned by the client) alongside plaintext :8085 for older clients - still run tether behind a tunnel (Tailscale / WireGuard / SSH) or keep it LAN-only.'
}

Install-Tether
