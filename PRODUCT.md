# Product

<!-- impeccable:product-schema 1 -->

## Platform

iOS

## Users

Primary users are developers and operators who run shells on their own machines or LAN/VPN hosts and want those sessions on their phone without babysitting SSH. Typical scene: evening or night use, phone beside other work, checking long-running jobs, answering an agent's prompt, hopping between hosts.

## Product Purpose

Tether is a native iOS terminal for your own machines. It connects over SSH to `zmx` — a persistent session manager on the host — attaches a session, and renders the live shell. Success means the session stays alive across disconnects, backgrounding, and reboots (because zmx owns it on the host), and the phone remains usable for real terminal work.

## Positioning

Sessions survive because they live in `zmx` on the host, not in the app — reattaching is not a fresh shell. Tether is a pure SSH client: no server to run, no custom transport, nothing exposed but SSH. Around that core: multi-host profiles with an on-device key vault, host-key trust-on-first-use, git diff of the session's working directory, send file / photo, session switch / kill / history, and encrypted push when an agent needs you.

## Operating Context

- No server binary. The host runs `zmx` (the session manager the app attaches to) and, optionally for push, `tether-notify` (a small Go CLI). State the app cares about lives on the phone.
- Client: native Swift / SwiftUI on iOS only. The terminal grid comes from SwiftTerm's headless VT engine; Tether renders it. Desktop / web / Android are not part of v5.
- Transport is SSH (libssh2) over LAN or a tunnel. Auth is a key held in the iOS Keychain (in memory to libssh2) or a password; an unknown host key is pinned on first connect and a later change is refused. Push ciphertext is end-to-end; the relay and Apple never see plaintext.
- Terminal is the primary work surface; the session drawer, utility key bar, and git / history / send overlays are secondary.
- Themes: Default dark / light plus Catppuccin flavors for chrome + terminal.

## Capabilities and Constraints

- SSH PTY streamed into a VT emulator grid (TUIs, box drawing, CJK / emoji)
- zmx session list / switch / kill / history over `ssh exec`; live working-directory tracking
- Multi-host profiles; on-device ed25519 key vault (generate / import / paste, randomart, fingerprint)
- Git diff over exec, send file / photo over SCP, select-and-copy scrollback history
- Foreground-redial reconnect; on first connect, attach an existing session rather than force a new one
- Appearance: theme preference + terminal font
- iOS-only design language: must work under thumb, with the soft keyboard and utility bar, one-handed

## Brand Commitments

- Product name: **Tether**
- User binding (2026-07-31): dark mode remains a first-class, night-usable default — not a light-only chrome redesign. Light (system / Default light) may exist, but the primary use scene is dark.
- User binding (2026-07-31): visual direction must stay **relatable** for a remote-shell tool (familiar density and affordances); avoid museum/poster chrome that fights the PTY.
- Theme set: **Default dark** / **Default light** (instrument bezel chrome; terminal well Mocha / Latte) plus Catppuccin Latte / Frappé / Macchiato / Mocha as optional full themes. System follows OS into Default dark / Default light.

## Evidence on Hand

- Code and docs in this repo (`CLAUDE.md`, `clients/apple`, `apps/tether-notify`)
- Live UI: the native iOS client (Home / key vault, terminal, session drawer, git diff, history)
- No separate marketing site or brand kit in-repo (`icon.png` at repo root)
- Do not fabricate customers, benchmarks, or usage stats

## Product Principles

1. The PTY is the product — chrome serves it, never competes with it.
2. Persistence lives in zmx on the host; the UI should make "still running" obvious on reattach.
3. Multi-host and session state must stay scannable under thumb and under stress.
4. Night / low-light use is the default scene; dark surfaces are not optional decoration.
5. Familiar terminal affordances beat ornamental UI; distinction lives in precise details.
