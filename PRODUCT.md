# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Primary users are developers and operators who run shells on their own machines or LAN/VPN hosts and want those sessions available from a phone or desktop without babysitting SSH. Typical scene: evening or night use, phone or laptop beside other work, checking long-running jobs, answering prompts, hopping between hosts.

## Product Purpose

Tether is a persistent remote-shell console. A Bun/Hono server owns real PTY sessions; clients reconnect, replay missed output, and keep working. Success means the shell stays alive across disconnects and server restarts, and the client remains usable for real terminal work on mobile and desktop.

## Positioning

Sessions survive client disconnect and server restart via detached holder processes and SQLite-logged replay — not a fresh SSH each open. Around that core: multi-host profiles, git review/stage/commit, workspace files, uploads, and HTML presentations pushed from a coding agent to the client.

## Operating Context

- Server binary/CLI on the host (`tether serve` / daemon); state in `~/.tether/`
- Clients: native Swift on iOS and Tauri on Linux/Windows/macOS, both over one shared Rust core (`crates/tether-core`). Android is discontinued.
- Transport is typically LAN or tunnel (Tailscale / WireGuard / SSH); API password-authed, not end-to-end encrypted by default
- Terminal is the primary work surface; drawer sessions, utility key bar (mobile), git/file/presentation overlays are secondary
- Themes today: Catppuccin flavors (latte / frappe / macchiato / mocha) for chrome + terminal

## Capabilities and Constraints

- Real PTY streaming over WebSocket with log replay (`sinceId`)
- Multi-host drawer; per-host auth and health
- Git diff/stage/commit, file tree/viewer, uploads, presentations
- Appearance: theme preference + terminal font
- Native iOS + desktop share one Rust core; design language must work on phone (thumb, soft keyboard, utility bar) and desktop (sidebar, window chrome)
- Open: whether chrome and terminal palettes stay coupled or split

## Brand Commitments

- Product name: **Tether**
- User binding (2026-07-31): dark mode remains a first-class, night-usable default — not a light-only chrome redesign. Light (system / Default light) may exist, but the primary use scene is dark.
- User binding (2026-07-31): visual direction must stay **relatable** for a remote-shell tool (familiar density and affordances); avoid museum/poster chrome that fights the PTY.
- Theme set: **Default dark** / **Default light** (instrument bezel chrome; terminal well Mocha / Latte) plus Catppuccin Latte / Frappé / Macchiato / Mocha as optional full themes. System follows OS into Default dark / Default light.

## Evidence on Hand

- Code and docs in this repo (`CLAUDE.md`, `apps/desktop`, `clients/apple`, `apps/server`, `docs/`)
- Live UI: native iOS + Tauri desktop clients
- No separate marketing site or brand kit in-repo (`icon.png` at repo root)
- Do not fabricate customers, benchmarks, or usage stats

## Product Principles

1. The PTY is the product — chrome serves it, never competes with it.
2. Persistence and reconnect are the mechanism; UI should make “still running” obvious.
3. Multi-host and session state must stay scannable under thumb and under stress.
4. Night / low-light use is the default scene; dark surfaces are not optional decoration.
5. Familiar terminal affordances beat ornamental UI; distinction lives in precise details.
