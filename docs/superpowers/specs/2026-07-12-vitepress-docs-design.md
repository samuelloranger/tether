# Tether Documentation Site (VitePress) — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm), pending spec review
**Reference:** mirrors the VitePress setup in `../rawkoon` (structure, config shape, dark-only theme, GitHub-Pages-on-release deploy), with **Tether's own visual identity** and a **2-audience** information architecture.

## Goal

A VitePress documentation site for Tether, organized like rawkoon's but adapted to Tether: one combined **Using Tether** audience (the self-hoster who also uses the app) plus **Development**. Dark-only, Tether-branded, deployed to GitHub Pages on release.

## Non-goals

- No web app / PWA (Tether has none — the client is the mobile app).
- No light theme (dark-only, like rawkoon).
- No bundled web fonts (name families with system fallbacks, as rawkoon does).
- Not rewriting existing README/CLAUDE.md — the site reuses their content.

## Decisions (from brainstorm)

- **Theme:** Tether's identity (near-black/slate bg, indigo + cyan brand, Fira Code mono) — not rawkoon's terracotta. Same *mechanics* (`theme-without-fonts` + `custom.css`).
- **Deploy:** mirror rawkoon — GitHub Pages, `base: "/tether/"` under GitHub Actions, sitemap host `https://samlo.cloud/tether/`, workflow on `release: published`.
- **Content:** full content for both audiences, reusing README/CLAUDE.md/specs. Honest to the current state (single binary, password auth, no web client); no legacy/migration content.
- **IA:** 2 sections — **Using Tether** (self-host + usage merged) and **Development**.

## Setup / mechanics (mirrors rawkoon)

- **Dependency + scripts** in root `package.json`:
  - devDependency `vitepress@1.6.4`.
  - scripts: `"docs:dev": "vitepress dev docs"`, `"docs:build": "vitepress build docs"`, `"docs:preview": "vitepress preview docs"`.
- **`docs/.vitepress/config.mts`** — `defineConfig`:
  - `lang: "en-US"`, `title: "Tether"`, `description: "Persistent remote-shell console — documentation"`.
  - `base: process.env.GITHUB_ACTIONS === "true" ? "/tether/" : "/"`.
  - `sitemap: { hostname: "https://samlo.cloud/tether/" }`, `cleanUrls: true`, `appearance: false`.
  - `themeConfig`: `logo: { src: "/icon.svg", alt: "Tether" }`, `nav`, `sidebar` (below), `socialLinks: [{ icon: "github", link: "https://github.com/samuelloranger/tether" }]`, `outline: [2, 3]`.
  - No `vite.publicDir` override — the icon lives in `docs/public/` (VitePress serves it by default).
- **`docs/.vitepress/theme/index.ts`** — `import DefaultTheme from "vitepress/theme-without-fonts"; import "./custom.css"; export default DefaultTheme;` (verbatim rawkoon shape).
- **`docs/.vitepress/theme/custom.css`** — same variable structure as rawkoon's, Tether palette:
  - `color-scheme: dark`; `--vp-font-family-mono: "Fira Code", ui-monospace, monospace`; base font a neutral system sans (`ui-sans-serif, system-ui, sans-serif`).
  - Backgrounds: `--vp-c-bg: #05070e`, `--vp-c-bg-alt: #0b0f19`, elevated/soft/mute in the slate range (`#141a2b`-ish), dividers/borders slate.
  - Brand: `--vp-c-brand-1: #818cf8`, `-2: #6366f1`, `-3: #3730a3` (the AA-safe indigo), brand-soft `rgba(129,140,248,0.16)`; tip mapped to cyan `#22d3ee`.
  - Button brand: bg `#3730a3`, text `#ffffff`, hover `#4338ca` (keeps ≥4.5:1 with white, matching the app's contrast fix).
  - Text ramp: `--vp-c-text-1: #e2e8f0`, `-2: #cbd5e1`, `-3: #94a3b8`, `-4: #64748b`.
- **`docs/public/icon.svg`** — a small Tether mark: a rounded near-black tile with an indigo/cyan `>_` prompt glyph (echoes the app's `configIconBox` logo). Self-contained SVG.
- **`.github/workflows/docs-pages.yml`** — on `release: [published]`; `permissions: contents:read, pages:write, id-token:write`; `concurrency: github-pages`. Build job: `actions/checkout@v4` → `oven-sh/setup-bun@v2` → `bun install` → `actions/configure-pages@v5` → `bun run docs:build` → `actions/upload-pages-artifact@v4` (path `docs/.vitepress/dist`). Deploy job: `actions/deploy-pages@v4`. (Inline `setup-bun` + `bun install` because tether has no `.github/actions/setup` composite; otherwise identical to rawkoon's.)

## Information architecture

`nav`:
- `{ text: "Using Tether", link: "/getting-started" }`
- `{ text: "Development", link: "/architecture" }`

`sidebar`:
- **Using Tether**
  - Getting started → `/getting-started`
  - Terminal basics → `/terminal/basics`
  - Sessions & tabs → `/terminal/sessions`
  - Saved commands & search → `/terminal/saved-commands`
  - Security & networking → `/security`
  - Updating & data → `/updating`
- **Development**
  - Architecture → `/architecture`
  - Data flow → `/data-flow`
  - Decisions → `/decisions`
  - Contributing → `/development/contributing`

## Content (pages + what each covers)

- **`docs/index.md`** — home layout: hero (tagline "Persistent remote shells, on your phone." + install one-liner CTA), feature highlights (persistent/replayable sessions, mobile key layer, single-binary self-host, password auth).
- **`getting-started.md`** — end-to-end first run: (1) install the server (`install.sh` one-liner), (2) `tether set-password` **or** pair from the phone (TOFU), `tether start`; (3) install the mobile app via AltStore; (4) connect: host/port + password, the Test-connection flow. Links out to Security and the terminal pages.
- **`terminal/basics.md`** — tap-to-type, long-press to select, the soft-key bar (Ctrl/Tab/Esc/Del/arrows/Home/End/PgUp/PgDn), paste, hide keyboard, font size.
- **`terminal/sessions.md`** — multiple terminals as drawer tabs, server-side persistence across disconnects/restarts, reconnect + replay (`sinceId`), Kill vs Restart (with the destructive-action confirmations), rename.
- **`terminal/saved-commands.md`** — saving commands, running them; searching/copying the displayed transcript (scope honesty note).
- **`self-hosting` content is folded into `getting-started` + these two:**
  - **`security.md`** — the trust model: shared-password auth on all `/api/*` (HTTP + WS); traffic is **unencrypted** → run behind a tunnel (Tailscale / WireGuard / SSH) or keep LAN-only; `0.0.0.0` + open CORS rationale; no-password ⇒ all clients rejected.
  - **`updating.md`** — `tether update` (downloads + atomic-swaps the release binary, restarts); the full CLI (`serve|start|stop|restart|status|logs|set-password|update|version`); data location `~/.tether/config/tether.db`; env (`TETHER_PORT`, `TETHER_DB_PATH`, `TETHER_REPO_SLUG`); macOS-unsigned note.
- **`architecture.md`** — monorepo layout; server (Bun + Hono, PTY holder processes, `bun:sqlite` log cache, single compiled binary); mobile (Expo RN, VT emulator, LRU tab cache); the Bun ≥ 1.3.14 PTY requirement.
- **`data-flow.md`** — the core loop: WS open → replay `getLogs(sinceId)` → subscribe → PTY chunk → SQLite → broadcast; the holder unix-socket frame protocol; prune watermark / reset.
- **`decisions.md`** — single-binary server (why compile, atomic update), shared-password + tunnel (why not built-in TLS), no web client (mobile-only), dark-only.
- **`development/contributing.md`** — dev commands (`bun dev:server`, `bun dev:mobile`), build (`bun build:server`), lint/format/typecheck, no test runner + the custom-harness test pattern, conventions (Biome, `$name` SQLite params, migrations rules, Expo-57 docs rule).

## Testing / verification

- `bun run docs:build` completes with no dead links (VitePress fails the build on broken internal links) — the acceptance check.
- `bun run docs:dev` serves locally; spot-check nav/sidebar/theme render dark + Tether-branded.
- `docs-pages.yml` validates as YAML; deploy exercised on the next release (not in this change).

## Open questions

None blocking. Exact slate mid-tones and the icon glyph proportions are finalized during implementation against the running dev server.
