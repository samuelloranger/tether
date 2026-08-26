# Desktop app

Tether ships a native desktop client for **Linux, Windows, and macOS** alongside the iOS app. It's a [Tauri](https://tauri.app) application: a native window over [xterm.js](https://xtermjs.org), with the connection, replay, git and workspace logic in a Rust core it shares with the iOS client. The core opens the WebSocket itself and carries the shared secret in the `Authorization` header — a plain browser can't, which is why there's no in-browser client. It connects to your server exactly like the iOS app.

## Download & install

Grab the file for your platform from the [latest release](https://github.com/samuelloranger/tether/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| **Debian / Ubuntu / Mint** | `Tether_*_amd64.deb` | `sudo apt install ./Tether_*.deb` |
| **Fedora / RHEL** | `Tether-*.x86_64.rpm` | `sudo dnf install ./Tether-*.rpm` |
| **Any Linux (incl. Arch)** | `Tether_*_amd64.AppImage` | `chmod +x` then run — no install needed |
| **Windows** | `Tether_*_x64-setup.exe` or `_x64_en-US.msi` | run the installer |
| **macOS (Apple Silicon)** | `Tether_*_aarch64.dmg` | open, drag to Applications |
| **macOS (Intel)** | `Tether_*_x64.dmg` | open, drag to Applications |

::: tip Unsigned builds
The macOS and Windows builds aren't code-signed yet, so the OS may warn on first launch. On macOS: right-click the app → **Open**. On Windows: **More info → Run anyway**.
:::

## Connecting

Same as iOS: on the setup screen enter your server's **host/IP**, **port** (default `8085`), and **password**, then **Test connection** and **Save & connect**. The password is stored locally by the app. See [Getting started](/getting-started#_4-connect) for what each test result means, and [Security & networking](/security) — the password gates access but does not encrypt traffic, so run Tether behind a tunnel.

## Updating

The app checks for a newer release on launch (and on demand via the **⋯** menu → **Check for updates**). It tells you the new version and what you're on, and installs it when you accept.

Every build updates itself, and every download is verified against the bundled signing key before it is installed — a tampered or unsigned file is rejected rather than run.

- **AppImage, Windows, macOS** — replaced in place, then the app restarts.
- **`.deb` / `.rpm`** — the new package is handed to your package manager, which asks for admin rights. The build knows which package format it came from, so it fetches that format rather than a generic one.

::: tip Nothing to do on launch
Updates are not silent: you always get the prompt first, and declining keeps you where you are until the next launch.
:::

## How it differs from iOS

The desktop app is the same terminal — same server, same Rust core — retuned for a keyboard-and-mouse machine:

- **Docked session sidebar** — your terminals live in a permanent left sidebar instead of the slide-in drawer. Switch, create, rename, and kill from there; the active shell fills the rest of the window.
- **Physical keyboard** — there's no on-screen key bar. Type straight into the terminal; arrows, `Tab`/`Shift+Tab`, `Esc`, `Home`/`End`, `Page Up`/`Down`, `Delete`, the function keys, and `Ctrl`/`Alt` combos are all sent to the shell as you'd expect.
- **Mouse selection & clipboard** — drag to select terminal text natively.
  - `Ctrl` / `Cmd` + `C` — copies the selection when there is one, otherwise sends `Ctrl-C` (SIGINT) to the shell.
  - `Ctrl` / `Cmd` + `V` — pastes the clipboard into the shell (bracketed paste when the program supports it).

Everything else — persistent sessions, reconnect-and-replay, saved commands, transcript search — works identically across both apps, because it's the same server and the same core underneath.
