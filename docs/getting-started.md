# Getting started

Tether has two halves: a **server** you run on your machine, and a **client app** you connect with — on your phone (iOS) or your desktop (Linux, Windows, macOS). Set up the server first.

## 1. Install the server

```sh
curl -fsSL https://samlo.cloud/tether/install.sh | sh
```

This downloads a single self-contained binary for your OS/arch into `~/.local/bin/tether` — no bun, git, or node_modules required. If `tether` isn't found afterward, add `~/.local/bin` to your `PATH` (the installer prints the exact line).

## 2. Set a password and start it

Every client must authenticate with a shared password.

```sh
tether set-password      # prompts, hidden input
tether start             # runs in the background on :8085
tether status            # confirm it's up
```

You can also set the password later from the phone the first time you connect (see below).

## 3. Install a client

Pick the app for your device — both connect to the same server the same way.

- **Phone (iOS)** — install via [AltStore](https://altstore.io): set up AltServer on your Mac/PC, add the Tether source, and install the app. New releases show up in AltStore automatically.
- **Desktop (Linux / Windows / macOS)** — download the installer for your platform from the [latest release](https://github.com/samuelloranger/tether/releases/latest). See [Desktop app](/desktop) for the per-OS files and how it differs from mobile.

## 4. Connect

In the app's setup screen, enter your server's **host/IP**, **port** (default `8085`), and **password**, then **Test connection**. You'll get one of:

- **Reachable** — the server answered and the password is correct. Save & connect.
- **This server has no password yet** — you're pairing a fresh server; choose a password and the app sets it.
- **Wrong password** / **Unreachable** — fix and retry.

::: tip Encryption
The password controls *access*, not encryption. For encrypted transport, run Tether behind a tunnel — see [Security & networking](/security).
:::

Once connected, see [Terminal basics](/terminal/basics).

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
