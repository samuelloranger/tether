# Tether Documentation Site (VitePress) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dark, Tether-branded VitePress docs site under `docs/`, organized like rawkoon's (two audiences: Using Tether + Development), deployed to GitHub Pages on release.

**Architecture:** VitePress 1.6.4 at repo root (`docs/`), config in `docs/.vitepress/config.mts`, dark-only custom theme (`theme-without-fonts` + `custom.css`) in Tether's palette, content as Markdown pages, GitHub Pages deploy workflow on `release: published`.

**Tech Stack:** VitePress 1.6.4, Bun, GitHub Pages (actions/deploy-pages).

## Global Constraints

- VitePress version: **1.6.4** (match rawkoon).
- Dark-only: `appearance: false`, `color-scheme: dark`. No light theme.
- `base: process.env.GITHUB_ACTIONS === "true" ? "/tether/" : "/"`; sitemap host `https://samlo.cloud/tether/`; `cleanUrls: true`; `outline: [2, 3]`.
- Palette (Tether): bg `#05070e` / alt `#0b0f19`; brand `#818cf8`/`#6366f1`/`#3730a3` (indigo, `#3730a3` is the AA-safe button bg with white text); tip/accent cyan `#22d3ee`; text ramp `#e2e8f0`/`#cbd5e1`/`#94a3b8`/`#64748b`. Mono `"Fira Code", ui-monospace, monospace`.
- Content honest to current state (single binary, password auth, no web client). **No legacy/migration mentions.**
- Acceptance per task: `bun run docs:build` succeeds — VitePress fails the build on broken internal links, so every sidebar/nav link must resolve.
- Repo: `github.com/samuelloranger/tether`.

---

## File Structure

- `package.json` (root) — *modify*: add `vitepress` devDep + `docs:dev`/`docs:build`/`docs:preview` scripts.
- `docs/.vitepress/config.mts` — *create*: site config, nav, sidebar.
- `docs/.vitepress/theme/index.ts` — *create*: theme entry.
- `docs/.vitepress/theme/custom.css` — *create*: Tether dark palette.
- `docs/public/icon.svg` — *create*: Tether `>_` mark.
- `docs/index.md` — *create*: home.
- `docs/getting-started.md`, `docs/terminal/basics.md`, `docs/terminal/sessions.md`, `docs/terminal/saved-commands.md`, `docs/security.md`, `docs/updating.md` — *create*: Using Tether.
- `docs/architecture.md`, `docs/data-flow.md`, `docs/decisions.md`, `docs/development/contributing.md` — *create*: Development.
- `.github/workflows/docs-pages.yml` — *create*: Pages deploy.

---

### Task 1: Scaffold — deps, config, theme, icon, home, page stubs

Ends with a building, browsable site (all links resolve; content filled in Tasks 2–3).

**Files:** all of the above except the content bodies (created as stubs here) and the workflow (Task 4).

- [ ] **Step 1: Add VitePress dep + scripts** — from repo root:

```bash
bun add -d vitepress@1.6.4
```
Then edit `package.json` `scripts` to add (keep existing scripts):

```json
    "docs:dev": "vitepress dev docs",
    "docs:build": "vitepress build docs",
    "docs:preview": "vitepress preview docs"
```

- [ ] **Step 2: Create `docs/.vitepress/config.mts`**

```ts
import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  base: process.env.GITHUB_ACTIONS === "true" ? "/tether/" : "/",
  title: "Tether",
  description: "Persistent remote-shell console — documentation",
  sitemap: { hostname: "https://samlo.cloud/tether/" },
  cleanUrls: true,
  appearance: false,
  themeConfig: {
    logo: { src: "/icon.svg", alt: "Tether" },
    nav: [
      { text: "Using Tether", link: "/getting-started" },
      { text: "Development", link: "/architecture" },
    ],
    sidebar: [
      {
        text: "Using Tether",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Terminal basics", link: "/terminal/basics" },
          { text: "Sessions & tabs", link: "/terminal/sessions" },
          { text: "Saved commands & search", link: "/terminal/saved-commands" },
          { text: "Security & networking", link: "/security" },
          { text: "Updating & data", link: "/updating" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Data flow", link: "/data-flow" },
          { text: "Decisions", link: "/decisions" },
          { text: "Contributing", link: "/development/contributing" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/samuelloranger/tether" }],
    outline: [2, 3],
  },
});
```

- [ ] **Step 3: Create `docs/.vitepress/theme/index.ts`**

```ts
import DefaultTheme from "vitepress/theme-without-fonts";
import "./custom.css";

export default DefaultTheme;
```

- [ ] **Step 4: Create `docs/.vitepress/theme/custom.css`** (Tether palette; heading font = base sans, hero name = Fira Code as the terminal signature)

```css
:root {
  color-scheme: dark;
  --vp-font-family-base: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --vp-font-family-mono: "Fira Code", ui-monospace, monospace;

  --vp-c-bg: #05070e;
  --vp-c-bg-alt: #0b0f19;
  --vp-c-bg-elv: #0f1526;
  --vp-c-bg-soft: #0f1526;
  --vp-c-bg-mute: #1a2236;
  --vp-c-divider: #1a2236;
  --vp-c-divider-light: #232c44;
  --vp-c-border: #1a2236;
  --vp-c-gutter: #05070e;
  --vp-nav-bg-color: rgba(5, 7, 14, 0.96);

  --vp-c-text-1: #e2e8f0;
  --vp-c-text-2: #cbd5e1;
  --vp-c-text-3: #94a3b8;
  --vp-c-text-4: #64748b;

  --vp-c-brand-1: #818cf8;
  --vp-c-brand-2: #6366f1;
  --vp-c-brand-3: #3730a3;
  --vp-c-brand-soft: rgba(129, 140, 248, 0.16);
  --vp-c-tip-1: #22d3ee;
  --vp-c-tip-2: #22d3ee;
  --vp-c-tip-3: #0891b2;
  --vp-c-tip-soft: rgba(34, 211, 238, 0.16);

  --vp-button-brand-border: transparent;
  --vp-button-brand-text: #ffffff;
  --vp-button-brand-bg: #3730a3;
  --vp-button-brand-hover-border: transparent;
  --vp-button-brand-hover-text: #ffffff;
  --vp-button-brand-hover-bg: #4338ca;
  --vp-button-brand-active-border: transparent;
  --vp-button-brand-active-text: #ffffff;
  --vp-button-brand-active-bg: #4f46e5;
  --vp-button-alt-border: #232c44;
  --vp-button-alt-text: #cbd5e1;
  --vp-button-alt-bg: #0f1526;
  --vp-button-alt-hover-border: #3a4straipx;
  --vp-button-alt-hover-text: #e2e8f0;
  --vp-button-alt-hover-bg: #1a2236;

  --vp-home-hero-name-color: #e2e8f0;
  --vp-home-hero-name-background: none;
}

html,
body,
#app {
  background: #05070e;
}

body {
  font-family: var(--vp-font-family-base);
  color: #cbd5e1;
}

.VPNav {
  border-bottom: 1px solid #1a2236;
}

.VPNavBar {
  background: rgba(5, 7, 14, 0.86);
  backdrop-filter: blur(18px);
}

.VPNavBarTitle .logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}

.VPNavBarTitle .title {
  color: #e2e8f0;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.VPNavBarMenuLink {
  color: #94a3b8;
}

.VPNavBarMenuLink:hover,
.VPNavBarMenuLink.active {
  color: #818cf8;
}

.VPSidebar {
  border-right: 1px solid #1a2236;
  background: #0b0f19;
}

.VPSidebarItem.level-0 .text {
  color: #e2e8f0;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.VPSidebarItem.level-1 > .item > .link {
  border-radius: 8px;
  padding: 0 10px;
}

.VPSidebarItem.level-1.is-active > .item > .link {
  background: rgba(129, 140, 248, 0.12);
}

.VPSidebarItem.level-1.is-active > .item .link > .text,
.VPSidebarItem.level-1.is-link > .item > .link:hover .text {
  color: #818cf8;
}

.VPDocAsideOutline .outline-link.active {
  color: #818cf8;
}

.vp-doc h1 {
  border-bottom-color: #1a2236;
  letter-spacing: -0.02em;
}

.vp-doc h2 {
  border-top-color: #1a2236;
  letter-spacing: -0.01em;
}

.vp-doc a {
  color: #818cf8;
  text-underline-offset: 0.18em;
}

.vp-doc a:hover {
  color: #a5b4fc;
}

.vp-doc :not(pre) > code {
  border: 1px solid #232c44;
  border-radius: 6px;
  background: #0f1526;
  color: #67e8f9;
}

.vp-doc pre {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.vp-doc div[class*="language-"] {
  border: 1px solid #1a2236;
  border-radius: 12px;
  background: #0b0f19;
}

.vp-doc div[class*="language-"] code {
  color: #cbd5e1;
}

.VPHero .container {
  position: relative;
  overflow: hidden;
  border: 1px solid #1a2236;
  border-radius: 24px;
  background:
    radial-gradient(circle at 82% 14%, rgba(129, 140, 248, 0.14), transparent 34%),
    #0b0f19;
}

.VPHero .main {
  padding: 48px;
}

.VPHero .name {
  color: #818cf8;
  font-family: var(--vp-font-family-mono);
  letter-spacing: -0.04em;
}

.VPHero .text {
  color: #e2e8f0;
}

.VPHero .tagline {
  color: #94a3b8;
}

.VPHero .image-bg {
  width: 156px;
  height: 156px;
  background-image: radial-gradient(circle, rgba(34, 211, 238, 0.28), transparent 65%);
  filter: none;
}

.VPHero .image-src {
  max-width: 128px;
  border-radius: 28px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
}

.VPFeature {
  border-color: #1a2236;
  border-radius: 14px;
  background: #0b0f19;
}

.VPFeature.link:hover {
  border-color: #3730a3;
  background: #0f1526;
}

.VPFeature .title {
  color: #e2e8f0;
}

.VPFeature .details {
  color: #94a3b8;
}

.VPButton.brand,
.VPButton.alt {
  border-radius: 9px;
  font-weight: 650;
}

@media (max-width: 959px) {
  .VPHero .main {
    padding: 36px 28px 20px;
  }
}
```

**Note:** fix the obvious typo before saving — `--vp-button-alt-hover-border: #3a4straipx;` must be `--vp-button-alt-hover-border: #3a4a68;` (a slate hairline). (Called out explicitly so it isn't copied verbatim.)

- [ ] **Step 5: Create `docs/public/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Tether">
  <rect width="64" height="64" rx="16" fill="#0b0f19" stroke="#1a2236" stroke-width="1"/>
  <text x="12" y="42" font-family="Fira Code, ui-monospace, monospace" font-size="26" font-weight="700" fill="#818cf8">&gt;</text>
  <rect x="30" y="34" width="16" height="4" rx="2" fill="#22d3ee"/>
</svg>
```

- [ ] **Step 6: Create `docs/index.md` (home)**

```md
---
layout: home

hero:
  name: Tether
  text: Persistent remote shells, on your phone
  tagline: Real PTY shells on your server, streamed to the mobile app over WebSocket. They keep running when you disconnect — and survive server restarts.
  image:
    src: /icon.svg
    alt: Tether
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Development
      link: /architecture

features:
  - title: Sessions that survive
    details: Each shell lives in a detached holder process, logged to SQLite. Disconnect, sleep your phone, restart the server — reconnect and replay exactly where you left off.
  - title: Built for the phone
    details: A full VT emulator with a mobile key layer — Ctrl, Tab, Esc, arrows, paste — plus voice/swipe input, tabs, saved commands, and transcript search.
  - title: One binary to self-host
    details: Install with one command, no bun or node_modules on the box. A shared password gates access; tether update swaps the binary atomically.
---
```

- [ ] **Step 7: Create all content pages as minimal valid stubs** — so links resolve and the build passes. Each file gets a single H1 matching its sidebar label plus a one-line intro. Create:
  - `docs/getting-started.md` → `# Getting started\n\nInstall the Tether server and connect the mobile app.`
  - `docs/terminal/basics.md` → `# Terminal basics\n\nTyping, keys, selection, and paste in the mobile terminal.`
  - `docs/terminal/sessions.md` → `# Sessions & tabs\n\nMultiple terminals, persistence, and reconnect/replay.`
  - `docs/terminal/saved-commands.md` → `# Saved commands & search\n\nReusable commands and searching the transcript.`
  - `docs/security.md` → `# Security & networking\n\nHow access is gated and how to run Tether safely.`
  - `docs/updating.md` → `# Updating & data\n\nUpdating the server and where data lives.`
  - `docs/architecture.md` → `# Architecture\n\nHow the server and mobile client are built.`
  - `docs/data-flow.md` → `# Data flow\n\nThe streaming + replay loop end to end.`
  - `docs/decisions.md` → `# Decisions\n\nWhy Tether is built the way it is.`
  - `docs/development/contributing.md` → `# Contributing\n\nLocal development, build, and conventions.`

- [ ] **Step 8: Build + preview**

```bash
bun run docs:build
```
Expected: build completes, no "dead link" errors. Then `bun run docs:dev` and spot-check: dark Tether theme, both sidebar sections, logo renders.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock docs/.vitepress docs/public docs/index.md docs/getting-started.md docs/terminal docs/security.md docs/updating.md docs/architecture.md docs/data-flow.md docs/decisions.md docs/development
git commit -m "docs: scaffold VitePress site (config, Tether theme, nav, stubs)"
```

---

### Task 2: Using Tether content

Fill the six Using-Tether pages with real content (reuse `README.md` / server behavior). Overwrite each stub.

- [ ] **Step 1: `docs/getting-started.md`**

````md
# Getting started

Tether has two halves: a **server** you run on your machine, and the **mobile app** you install on your phone. Set up the server first.

## 1. Install the server

```sh
curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | sh
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

## 3. Install the mobile app

Install via [AltStore](https://altstore.io): set up AltServer on your Mac/PC, add the Tether source, and install the app. New releases show up in AltStore automatically.

## 4. Connect

In the app's setup screen, enter your server's **host/IP**, **port** (default `8085`), and **password**, then **Test connection**. You'll get one of:

- **Reachable** — the server answered and the password is correct. Save & connect.
- **This server has no password yet** — you're pairing a fresh server; choose a password and the app sets it.
- **Wrong password** / **Unreachable** — fix and retry.

::: tip Encryption
The password controls *access*, not encryption. For encrypted transport, run Tether behind a tunnel — see [Security & networking](/security).
:::

Once connected, see [Terminal basics](/terminal/basics).
````

- [ ] **Step 2: `docs/terminal/basics.md`**

````md
# Terminal basics

The mobile terminal is a full VT emulator with a key layer built for a phone.

## Typing

- **Double-tap** the terminal to bring up the keyboard and type. Input is sent straight to the shell as you type — dictation, swipe, and autocomplete all work.
- **Long-press** the terminal to open a selectable, copyable view of the displayed transcript.
- Scrolling never pops the keyboard; only a genuine tap does.

## The soft-key bar

A row of keys the on-screen keyboard doesn't give you: **Ctrl** (arms the next key for a Ctrl-combo), **Tab**, **Esc**, **Del**, **arrows**, **Home**, **End**, **PgUp**, **PgDn**, plus **paste** and **hide keyboard**.

## Font size

Adjust from the overflow menu (`⋯`) → Font size, between 8 and 24px. The terminal re-fits its grid and resizes the remote PTY to match.
````

- [ ] **Step 3: `docs/terminal/sessions.md`**

````md
# Sessions & tabs

## Multiple terminals

Open the drawer (menu icon) to see every terminal on the server and switch between them. Each is an independent shell. Only the active one holds a live WebSocket; switching detaches the others (their shells keep running on the server) and reattaches instantly from a small cache.

## Persistence & replay

The whole point of Tether: **the shell survives disconnects and server restarts.** Each session's PTY lives in a detached *holder* process, and every byte of output is logged to SQLite. When you reconnect, the server replays everything since the last line your device saw — so you never miss output, even after your phone slept for hours.

## Destructive actions

- **Restart terminal** (overflow menu) — terminates and respawns the shell, and **clears that terminal's scrollback history**. Confirmed before it runs.
- **Kill** (drawer) — deletes the process **and its saved output**. Confirmed before it runs; can't be undone.

## Rename

Overflow menu → Rename terminal. Names are stored server-side and shown in the drawer.
````

- [ ] **Step 4: `docs/terminal/saved-commands.md`**

````md
# Saved commands & search

## Saved commands

Overflow menu (`⋯`) → **Saved commands**. Save commands you run often (e.g. `git status`) and tap to send them to the active terminal. Stored on the device.

## Search & copy the transcript

- **Search displayed transcript** filters the currently displayed lines (visible screen + scrollback) as you type.
- **Copy displayed transcript** copies that same text to the clipboard.

::: info Scope
Search and copy operate on the **displayed** transcript held by your device — not the server's full history. The labels say so on purpose.
:::
````

- [ ] **Step 5: `docs/security.md`**

````md
# Security & networking

## The trust model

Every `/api/*` route — HTTP **and** the WebSocket upgrade — requires a shared password (`Authorization: Bearer <password>`), stored as an argon2 hash in the server's database. With no password set, the server rejects all clients. Set it with `tether set-password` or the first-run pairing flow in the app.

## Encryption is the tunnel's job

The password gates **access**, not the wire. Traffic is **unencrypted** — the server binds `0.0.0.0` with open CORS. Run Tether behind a tunnel for encryption:

- **Tailscale** or **WireGuard** — reach the server over the mesh/VPN.
- **SSH** — port-forward `8085` over an SSH tunnel.

Or keep it strictly LAN-only. Do not expose the port directly to the internet.

::: warning
A remote shell is a high-trust surface. Anyone with the password and network reach gets a shell.
:::
````

- [ ] **Step 6: `docs/updating.md`**

````md
# Updating & data

## Updating

```sh
tether update
```

Downloads the latest release binary for your platform, verifies it, atomically swaps it in, and restarts the daemon if it was running. No reinstall, no git.

## The `tether` CLI

One binary is the whole CLI:

```
tether serve | start | stop | restart | status | logs | set-password | update | version
```

- `serve` (or no argument) runs the daemon in the foreground; `start` runs it detached.
- pid + log live in `~/.tether/`.

## Data & environment

- Database (sessions + password) lives in `~/.tether/config/tether.db`.
- Environment: `TETHER_PORT` (default `8085`), `TETHER_DB_PATH` (override the DB path), `TETHER_REPO_SLUG` (update source, default `samuelloranger/tether`).

::: info macOS
Release binaries are unsigned. On first run macOS may need: `xattr -d com.apple.quarantine ~/.local/bin/tether`.
:::
````

- [ ] **Step 7: Build + commit**

```bash
bun run docs:build   # expect: success, no dead links
git add docs/getting-started.md docs/terminal docs/security.md docs/updating.md
git commit -m "docs: Using Tether content (getting started, terminal, security, updating)"
```

---

### Task 3: Development content

- [ ] **Step 1: `docs/architecture.md`**

````md
# Architecture

Tether is a Bun + TypeScript monorepo (Bun workspaces).

## Monorepo

- `apps/server/` — Bun + Hono backend. Spawns PTYs, logs to SQLite, serves the API/WebSocket. Ships as a single compiled binary that is also the `tether` CLI.
- `apps/mobile/` — Expo React Native app. VT emulator, session drawer, LRU tab cache. The only client (no web UI).

## Server

- **PTY:** shells are spawned with `Bun.spawn(..., { terminal })` — requires **Bun ≥ 1.3.14**. On older Bun, `proc.terminal` is undefined and sessions die instantly.
- **Holder processes:** each session's PTY runs in its own detached *holder* (`tether holder …`) that owns a unix socket. The server attaches over that socket, so the shell outlives server restarts; on boot the server reattaches to survivors.
- **SQLite log cache:** every output chunk is written to `bun:sqlite` with an incrementing id, capped per session and pruned periodically.
- **Auth:** a Hono middleware requires the shared password on all `/api/*` routes and the WS upgrade.

## Mobile

- Full VT emulator (`src/terminal.ts`) — grid + scrollback, cursor addressing, alt-screen.
- Multiple sessions as drawer tabs; only the active tab holds a live socket + emulator; an LRU cache (cap 3) makes switching instant.
- Diff-based input so dictation/swipe/autocomplete reach the PTY.
````

- [ ] **Step 2: `docs/data-flow.md`**

````md
# Data flow

The core loop, from key press to pixels and back.

## Connect & replay

1. The client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=` with the password header.
2. The server ensures the session's holder is running (spawns or reattaches), then **replays** every log row after `sinceId` from SQLite to catch the client up.
3. It subscribes the client to live output.

## Live output

`PTY chunk → holder → server → addTerminalLog (SQLite, returns row id) → broadcast to subscribers`. The client stores the latest row id it has seen; on reconnect it sends that as `sinceId`, so only missed output is replayed.

## Holder protocol

Server ↔ holder speak newline-delimited JSON over a unix socket, base64 payloads for binary safety:

- server → holder: `{t:'i', d}` (input), `{t:'r', c, r}` (resize), `{t:'k'}` (kill)
- holder → server: `{t:'o', d}` (output), `{t:'x', code}` (exit)

## Pruning

`terminal_logs` is capped (~2000 rows/session). When rows are pruned, a watermark records it; if a reconnecting client's `sinceId` predates the prune, the server tells it to reset the emulator before the replay so there's no hole.
````

- [ ] **Step 3: `docs/decisions.md`**

````md
# Decisions

Why Tether is built the way it is.

## Single-binary server

The server ships as a `bun build --compile` binary that is both the daemon and the CLI. It removes bun/git/rsync/node_modules from the deployed box, makes `tether update` an atomic single-file swap, and can't leave a half-updated install.

## Shared password + tunnel, not built-in TLS

Auth is a shared password on every request. Encryption is delegated to a tunnel (Tailscale/WireGuard/SSH) rather than terminating TLS in the server: self-signed certs plus WebSocket on iOS are fragile, and self-hosters typically already run a tunnel. The app never claims the password encrypts traffic.

## Mobile-only, no web client

The client is the Expo app. A phone is where "my shell dropped when the screen locked" actually hurts, and a native app gives a real key layer and background-survival story a browser can't.

## Dark-only

Tether is a terminal. The UI commits to one dark, near-black identity rather than theming both ways.
````

- [ ] **Step 4: `docs/development/contributing.md`**

````md
# Contributing

## Prerequisites

Bun **≥ 1.3.14** (PTY support). Install workspaces from the repo root:

```sh
bun install
```

## Run from source

```sh
bun dev:server     # backend on :8085, watch mode
bun dev:mobile     # Expo Metro bundler
```

Source runs use a repo-local `apps/server/config/tether.db`, isolated from any installed binary. Override with `TETHER_DB_PATH`.

## Build the binary

```sh
bun build:server   # compiles apps/server/dist/tether
bun start:server   # runs the compiled binary
```

## Checks

```sh
bun lint                          # Biome (server) + Expo lint (mobile)
bun format                        # biome check --write (server)
bun --cwd apps/server typecheck   # tsc --noEmit
```

There is no test runner; unit tests are plain scripts run with `bun run <file>.test.ts` (server) or `bun test` from a package dir, using a small custom `ok`/`eq` harness.

## Conventions

- Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100.
- SQLite uses `$name` named params. Schema changes append a new **versioned, idempotent** entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Mobile: read the exact Expo 57 docs (`https://docs.expo.dev/versions/v57.0.0/`) before writing Expo code.
````

- [ ] **Step 5: Build + commit**

```bash
bun run docs:build   # expect: success, no dead links
git add docs/architecture.md docs/data-flow.md docs/decisions.md docs/development/contributing.md
git commit -m "docs: Development content (architecture, data flow, decisions, contributing)"
```

---

### Task 4: GitHub Pages deploy workflow

- [ ] **Step 1: Create `.github/workflows/docs-pages.yml`**

```yaml
name: Deploy documentation to GitHub Pages

on:
  release:
    types: [published]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - uses: actions/configure-pages@v5
      - run: bun run docs:build
      - uses: actions/upload-pages-artifact@v4
        with:
          path: docs/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docs-pages.yml')); print('valid')"
```
Expected: `valid`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docs-pages.yml
git commit -m "ci: deploy docs to GitHub Pages on release"
```

---

## Self-Review

**Spec coverage:**
- Deps/scripts, config (base/sitemap/cleanUrls/appearance/outline/nav/sidebar/social/logo) → Task 1. ✓
- Theme (index.ts + custom.css Tether palette), icon.svg → Task 1. ✓
- 2-audience IA (Using Tether / Development) → Task 1 config; content Tasks 2–3. ✓
- Home hero + features → Task 1 Step 6. ✓
- All content pages (getting-started, terminal/*, security, updating, architecture, data-flow, decisions, contributing) → Tasks 2–3, full content. ✓
- Deploy workflow on release, `docs/.vitepress/dist`, inline setup-bun → Task 4. ✓
- Honest/no-legacy content → verified in each page body (binary, auth, no web client; no migration mentions). ✓

**Placeholder scan:** no TBD/TODO; every page has complete content; the one deliberate typo in `custom.css` is flagged with its exact correction in Task 1 Step 4's note.

**Type/name consistency:** sidebar links match created file paths (`/terminal/basics` ↔ `docs/terminal/basics.md`, `/development/contributing` ↔ `docs/development/contributing.md`); nav targets (`/getting-started`, `/architecture`) exist; `icon.svg` path (`/icon.svg`) served from `docs/public/`.

## Notes / risks

- `bun add -d vitepress@1.6.4` updates `bun.lock` — commit it (Task 1 Step 9).
- VitePress dead-link checking is the primary correctness gate; keep every intra-site link pointing at a file created in this plan.
- GitHub Pages must be enabled for the repo (Settings → Pages → Source: GitHub Actions) for the deploy job to publish — a one-time repo setting, noted for the operator.
