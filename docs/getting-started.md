# Getting started

Tether has two halves: a **server** you run on your machine, and a **client app** you connect with — on your phone (iOS) or your desktop (Linux, Windows, macOS). Set up the server first.

## 1. Install the server

On **Linux or macOS**:

```sh
curl -fsSL https://samlo.cloud/tether/install.sh | sh
```

This downloads a single self-contained binary for your OS/arch into `~/.local/bin/tether` — no bun, git, or node_modules required. If `tether` isn't found afterward, add `~/.local/bin` to your `PATH` (the installer prints the exact line).

On **Windows**, in PowerShell:

```powershell
irm https://samlo.cloud/tether/install.ps1 | iex
```

Same idea: one self-contained `tether.exe`, installed to `%LOCALAPPDATA%\Programs\tether` with no administrator prompt, and that directory added to your user `PATH` — open a new terminal for it to take effect. Windows x64 only. See [Windows server](/windows) for which shells work, the firewall prompt on first start, and what behaves differently there.

## 2. Set a password and start it

Every client must authenticate with a shared password.

```sh
tether set-password      # prompts, hidden input
tether start             # runs in the background on :8085
tether status            # confirm it's up
```

You can also set the password later from the phone the first time you connect (see below).

## 3. Install a client

Pick the app for your device — both connect to the same server the same way. Every link here always resolves to the newest release. (Android is not supported; builds were discontinued after v2.8.12.)

| Device | Get the latest |
| --- | --- |
| **iOS** | [TestFlight](https://testflight.apple.com/join/j7rPkfhq) — open the link on your iPhone |
| **Desktop** (Linux / Windows / macOS) | see [Desktop app](/desktop) for the per-OS installer |

- **iOS** — install [TestFlight](https://apps.apple.com/app/testflight/id899247664), then open the [public beta link](https://testflight.apple.com/join/j7rPkfhq). No Mac, no AltServer, and nothing to re-sign every week. New builds arrive automatically; each is testable for 90 days.
- **Desktop** — download the installer for your platform; see [Desktop app](/desktop) for the per-OS files and how it differs from mobile.

## 4. Connect

In the app's setup screen, enter your server's **host/IP**, **port** (default `8085`), and **password**, then **Test connection**. You'll get one of:

- **Reachable** — the server answered and the password is correct. Save & connect.
- **This server has no password yet** — you're pairing a fresh server; choose a password and the app sets it.
- **Wrong password** / **Unreachable** — fix and retry.

::: tip Encryption
The password controls *access*, not encryption. For encrypted transport, run Tether behind a tunnel — see [Security & networking](/security).
:::

Once connected, see [Terminal basics](/terminal/basics).

## 5. Turn on notifications (optional)

Tether can notify you when a session needs input, a program raises an alert, a session exits, or a long command finishes. Open the host's settings, turn on **Push to my devices**, and pick which of those four you want. The line under the toggle tells you how many devices the server can reach — if it says none, allow notifications when the app asks and reopen the screen.

Your phone generates an encryption key and shares it only with your own servers, so the relay that forwards the push to Apple receives a blob it cannot read. See [Privacy](/privacy) for what that relay does and does not see.

::: tip Notifications need the TestFlight build
Apple only issues push entitlements to properly signed apps, so notifications arrive on the TestFlight build only — one of the reasons sideloading was dropped. iOS only for now; the desktop app raises its own local notifications instead.
:::

## Show an agent preview

Codex CLI and Claude Code can show a generated HTML/CSS/JavaScript preview directly in Tether — on desktop and iOS. Install the optional skill once for the CLI you use:

```sh
tether present agent-install          # every detected CLI
tether present agent-install codex    # Codex CLI only
tether present agent-install claude   # Claude Code only
```

An agent can then create a preview directory and open its entry file:

```sh
tether present ./preview/index.html --project creneau --title "New feature"
```

The preview appears beside terminals in the workspace navigator. Tether watches its directory and reloads it automatically after changes. Preview URLs are capability-scoped and can only serve files below that preview directory; previews are ephemeral and are cleared when Tether restarts.

Clear generated previews when the work is accepted or abandoned:

```sh
tether present reset             # every preview
tether present reset creneau     # one project
```
