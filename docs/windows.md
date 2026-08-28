# Windows server

The Tether server runs natively on Windows — the same single binary as the Linux and macOS builds, with the PTY layer sitting on [ConPTY](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) instead of a Unix PTY. Sessions, replay, git, the workspace file tree, uploads and previews all work; a handful of things behave differently because Windows has no equivalent of the mechanism the POSIX build uses, and those are listed under [Limitations](#limitations).

This page is about the *server*. The Windows **desktop client** is a separate download — see [Desktop app](/desktop).

## Install

Run in PowerShell:

```powershell
irm https://samlo.cloud/tether/install.ps1 | iex
```

This downloads `tether-windows-x64.exe` from the latest release, checks it against the SHA256 published beside it, and installs it as `%LOCALAPPDATA%\Programs\tether\tether.exe`. Nothing needs administrator rights: that is the per-user location, so no UAC prompt and no `Program Files`.

The installer also adds that directory to your **user PATH** if it isn't there. A shell reads `PATH` once, at start, so open a new terminal afterwards. This is worth doing rather than skipping: coding agents call `tether signal` and `tether present` from *inside* a Tether session, and if `tether` doesn't resolve there, agent previews and the Claude Code hooks that report a session's state fail quietly.

Then, as on any other platform:

```powershell
tether set-password
tether start
tether status
```

The installer accepts the same environment variables as its POSIX counterpart — `TETHER_VERSION` to pin a release, `TETHER_REPO_SLUG` to install from a fork, `DRY_RUN=1` to print the plan and stop:

```powershell
$env:TETHER_VERSION = 'v3.1.2'
irm https://samlo.cloud/tether/install.ps1 | iex
```

::: tip Reinstalling over a running server
Windows keeps a write lock on the image of any running executable, so `tether.exe` can't be replaced while the daemon is up. Run `tether stop` first — the installer detects the lock and says so rather than failing on a sharing violation.
:::

Only **x64** is published. Windows on ARM can emulate x64, but an emulated Bun plus ConPTY is untested, so both the installer and `tether update` refuse it rather than hand you a binary nobody has run.

## The firewall prompt

The first time the server binds, Windows Defender Firewall pops its "allow this app to communicate" dialog. The server listens on `0.0.0.0:8085` (and `0.0.0.0:8443` for TLS) so that other devices can reach it — if you dismiss the prompt or deny it, the server still starts and `localhost` still works, but nothing else on your network will connect, which reads as "Unreachable" in the client.

Allow it for the network profiles you actually connect over. If you dismissed the prompt, the rule can be added afterwards in **Windows Defender Firewall → Allow an app through firewall**, or from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName 'Tether' -Direction Inbound -Program "$env:LOCALAPPDATA\Programs\tether\tether.exe" -Action Allow
```

This only decides who can *reach* the port. Who can *use* it is still the password — see [Security & networking](/security).

## Shells

Tether picks a default shell for new sessions and injects a small amount of shell integration into it, so the client knows each session's working directory (which is what drives the git panel and the workspace file tree). Windows has no `/etc/passwd` and no per-user login shell, so the default is chosen by probing: **PowerShell 7 (`pwsh.exe`)** if it's installed, otherwise **Windows PowerShell (`powershell.exe`)**, otherwise whatever `ComSpec` points at (`cmd.exe`).

You can override it per host in the client's settings (`session.defaultShell`). What you get depends on the shell:

| Shell | Integration |
| --- | --- |
| **PowerShell 7** (`pwsh.exe`) | Full. Tether generates a profile script and starts the shell with `-NoLogo -NoExit -File <profile>`, which runs *after* your own profiles, so your setup is untouched. It installs a `prompt` function that emits an OSC 7 escape with the current directory and draws the same abbreviated-path + git-branch prompt as the POSIX build. |
| **Windows PowerShell** (`powershell.exe`) | Same as above — identical generated profile. |
| **cmd.exe** | Partial. `cmd` has no rcfile; its only hook is the `PROMPT` string, which does understand `$E` (escape) and `$P` (cwd), so Tether sets a `PROMPT` that emits OSC 7 alongside the usual `C:\dir>`. Directory tracking works; there is no branch display. |
| Anything else | None. The shell is spawned as-is with no arguments, and the session's directory never updates. |

::: warning Don't point `defaultShell` at Git Bash
Setting `defaultShell` to Git for Windows' or MSYS2's `bash.exe` looks like it should work — you get a familiar shell, and Tether's bash integration even loads. But an MSYS shell reports its directory as `/c/Users/you/...`, a path no Windows API can resolve. The session runs, but the git panel, the file tree, uploads and previews all fail to find anything, because every one of them starts from that directory.

This is also why Tether deliberately ignores `SHELL` when picking the default: Git for Windows exports `SHELL=<its bash.exe>` to every process it launches, so a daemon started from a Git Bash prompt would otherwise hand every session an MSYS shell. If you want bash, run it *inside* a PowerShell session rather than making it the session shell.
:::

## Updating

`tether update` works the same way it does elsewhere: it downloads the newest `tether-windows-x64.exe`, verifies the checksum, swaps it in, and restarts the daemon if it was running.

The swap is where Windows differs. Overwriting a running executable is refused by the OS, but *renaming* one is allowed — the mapping follows the file, not the path. So the update moves the running binary aside to `tether.exe.old` and puts the new one at the freed name. That leftover can't be deleted at the time it's created, because the update command is itself executing from it; it's swept at the start of the *next* update, once every process running it has exited. Seeing a `tether.exe.old` next to your `tether.exe` is expected, not a failed update. If you'd rather not wait, it can be deleted by hand once the daemon has been restarted.

## Limitations

These are consequences of Windows not offering the mechanism the POSIX build relies on, not bugs waiting to be fixed.

### Ctrl+C interrupts child commands, not the shell itself

On POSIX the PTY line discipline turns the `0x03` byte into `SIGINT` for the foreground process group. ConPTY does not do this — it delivers the byte to the app as a plain character — and `GenerateConsoleCtrlEvent` does not reach ConPTY clients either. So Tether reproduces the *effect* instead: it reads the console's `ENABLE_PROCESSED_INPUT` flag, which is the faithful stand-in for the POSIX `ISIG` flag (it is precisely the bit meaning "turn Ctrl+C into an interrupt rather than a keystroke") and tracks the foreground app live.

- A raw-mode app — vim, less, or PSReadLine sitting at its prompt — has the flag clear, so it receives the byte untouched and handles it itself. Nothing is killed.
- A running job has it set, so Tether takes down the shell's child process subtree. The shell survives; the point of an interrupt is to get the prompt back, not to end the session.

The honest limitation: work running *inside the shell process itself* — a PowerShell pipeline or loop, rather than a launched command — has no subtree to stop and cannot be interrupted. Child commands, which is what agents, builds and dev servers are, can.

### The working directory only updates on a prompt redraw

The POSIX build reads a process's current directory straight from the kernel (`/proc/<pid>/cwd`, or `lsof` on macOS), which works no matter what is in the foreground. Windows exposes no equivalent: a process's cwd lives in its PEB, reachable only through a cross-process memory read that needs native code and, for elevated targets, privileges the daemon doesn't have — `Win32_Process` offers a command line and an executable path, but no directory.

So on Windows, directory tracking rests entirely on the OSC 7 escapes the shell integration injects. In practice that means a session's directory moves when the shell redraws its prompt, and can lag behind a `cd` performed inside a full-screen TUI until you're back at the prompt. It also means a shell with no integration (see the table above) never reports one at all.

### Windows on ARM is unsupported

The release matrix builds Windows x64 only. Both the installer and `tether update` refuse an ARM64 host rather than resolve to an asset that has never been exercised there.

## Everything else

Data lives in `%USERPROFILE%\.tether` — `config\tether.db` holds the password and sessions, and the pid and log files sit beside it, exactly as `~/.tether` does elsewhere. `TETHER_DB_PATH`, `TETHER_PORT`, `TETHER_TLS`, `TETHER_TLS_PORT` and `TETHER_REPO_SLUG` all behave the same; see [Updating & data](/updating).
