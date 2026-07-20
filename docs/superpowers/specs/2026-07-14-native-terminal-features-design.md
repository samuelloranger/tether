# Native terminal features — design

Date: 2026-07-14

## Context

Tether's terminal (mobile app + desktop Tauri shell, both built on `apps/mobile/src/terminal.ts`'s VT emulator) covers the core PTY streaming/replay loop well, but is missing a set of features that native terminal apps (iTerm2, WezTerm, Alacritty, Terminal.app) take for granted. This spec covers adding all of them in one pass.

## Value summary

| Feature | User value | Platform | Relative effort |
|---|---|---|---|
| Bell (visual/audio) | Notice command done/error without watching the screen | Mobile + desktop | Low |
| OSC 0/2 window title | Titlebar shows real running command, not just session name | Mobile + desktop | Low |
| OSC 7 cwd tracking | Enables accurate file-upload placement + real cwd subtitle | Mobile + desktop | Low (shared infra) |
| DECSCUSR cursor shape | Vim mode indicator (block/bar/underline) | Mobile + desktop | Low |
| OSC 133 prompt markers | Jump to prev/next command, exit-status-colored prompt | Mobile + desktop | Med |
| OSC 8 hyperlinks | Correct tap targets incl. non-URL-shaped links, no regex false positives | Mobile + desktop | Med |
| File upload (image picker) | Attach a photo from the library, lands on host, path typed in | Mobile | Low-Med |
| File upload (native drag-drop) | Drag a file from Files/Photos/another app onto the terminal | Mobile/iPadOS | Med-High (new native dep) |
| File upload (desktop drag-drop) | Drag a file from the desktop onto the terminal window | Desktop | Low (reuses upload pipe) |
| Theme/palette picker | Personal taste, accessibility/contrast | Mobile + desktop | Low-Med |
| Font/ligature picker | Legibility, code symbol clarity (`=>`, `!=`) | Desktop only | Low-Med |
| Split panes (layout only) | See two existing sessions side by side without switching tabs | Desktop only | High (refactor) |

Highest value-per-effort: bell, cursor shape, theme picker, OSC 7 (unlocks upload placement). Highest total value but priciest: split panes, native iOS drag-drop, OSC 133.

## Decisions made during brainstorming

1. **Scope**: one spec, one phased implementation plan (not tiered specs) — features are independent enough that a single plan can sequence them by risk/dependency.
2. **Platform scope**: per-feature judgment. Cross-cutting stream-parsed features (bell, title, cwd, cursor shape, prompt markers, hyperlinks, theme) ship to both mobile and desktop. Desktop-only where the feature is inherently desktop (font/ligatures, split panes). Mobile-only where inherently mobile (native drag-drop via iOS/iPadOS inter-app drag).
3. **Split panes semantics**: **layout split of existing sessions**, not true tmux-style multi-PTY-per-session. Each pane is an existing session (its own ws/PTY already), just laid out side-by-side instead of switched between via tabs. No server changes. 2-pane split, desktop only, reversible via a "1 pane" toggle back to current tab behavior.
4. **Cwd tracking mechanism**: **OSC 7** shell integration (`\x1b]7;file://host/path\x07`), emitted from the existing `tether.bashrc` PS1 hook (`apps/server/src/server/pty.ts` already customizes PS1 there for the fish-like prompt). Parsed client-side in `terminal.ts` alongside the existing OSC/CSI state machine. Rejected alternative: `/proc/<pid>/cwd` + `lsof` fallback — OS-specific, racy, forks a process on macOS. OSC 7 is bash-only for now; other shells can add their own hook later if needed.
5. **File-upload architecture**: client is the source of truth for cwd (already parsing the stream for rendering) — it sends `{cwd, filename}` alongside the upload bytes rather than the server independently tracking session cwd. One `POST /api/sessions/:id/upload` endpoint serves **three** entry points: mobile image-picker button, mobile/iPadOS native drag-drop, and desktop Tauri file-drop. This was explicitly chosen over a "local path insert only" approach for desktop drag-drop, because the PTY may be running on a remote host — a locally-dropped file's path wouldn't exist there. Reusing the upload pipe makes desktop drag-drop correct whether the server is local or remote.
6. **iOS/iPadOS native drag-drop**: use [`expo-drag-drop-content-view`](https://github.com/AlirezaHadjar/expo-drag-drop-content-view) (Swift/Kotlin native module, v0.9.2 as of June 2026, iOS/Android/web, React Native new-architecture compatible). `onDrop` payload gives `{type, uri, base64}` directly, which feeds the same upload call as the image-picker button. Requires a custom dev build (Expo Go unsupported) — no change to how this repo already builds (`npx expo run:ios --device` per `apps/mobile/AGENTS.md`), but does add a new native dependency and a config-plugin entry in `app.json`.

## Subsystems

### 1. Stream-parsed additions (mobile `terminal.ts` VT emulator — no server changes)

Bell, OSC 0/2 title, OSC 7 cwd, DECSCUSR cursor shape, OSC 133 prompt markers, and OSC 8 hyperlinks all share one shape: extend the existing `case 'osc'` / `case 'csi'` state machine, store the parsed state on the `Terminal` instance or per-row, and have the UI layer read it.

- **Bell**: `0x07` handler (currently a no-op, "bell, ignore") sets a `bellRing` flag/timestamp instead of dropping it. UI flashes + optional haptic, then clears the flag.
- **OSC 0/2 title**: new OSC subtype sets `this.title`. `TitleBar` reads it instead of the static session name.
- **OSC 7 cwd**: new OSC subtype parses `file://host/path`, sets `this.cwd`. Consumed by the file-upload subsystem (below) and shown as the TitleBar subtitle.
- **DECSCUSR cursor shape**: new CSI `q` case sets `this.cursorStyle` (block/bar/underline, blink on/off). Cursor renderer in `TermRow` reads it instead of a hardcoded block.
- **OSC 133 prompt markers**: new OSC subtype marks a row index as prompt-start in the row model, and captures exit code from `133;D;<code>`. Enables "jump to prev/next command" navigation and exit-status-colored prompt.
- **OSC 8 hyperlinks**: new OSC subtype attaches a `{url}` to the run of cells until the matching close sequence. `links.ts` prefers these explicit spans over its current regex reconstruction; the regex stays as a fallback for plain unmarked URLs (e.g. `ls` output with no OSC 8).

### 2. File-upload subsystem (new)

- New server endpoint `POST /api/sessions/:id/upload` (multipart), password-gated like the rest of `/api/*`. Body: file bytes + filename + client-supplied `cwd`. Server writes to `cwd/filename` (collision-suffixed on conflict), returns the written path.
- Mobile: image-picker button in `UtilityBar` (`expo-image-picker`, same pattern as existing pickers in the repo) → upload call.
- Mobile/iPadOS: `expo-drag-drop-content-view` wraps the terminal view; `onDrop` → same upload call.
- Desktop: Tauri file-drop event on the terminal view → same upload call.
- On success, the client types the returned path into the input box — same mechanism the existing paste flow uses.
- Stateless write keyed off client-supplied cwd; no DB or session-state changes.

### 3. Rendering/config subsystem (independent)

- **Theme/palette picker**: new settings screen; palette = ANSI 16-color table + default fg/bg, stored via the existing `secureConfig`/`ConfigScreen` pattern. `TermRow` color resolution reads the active palette instead of hardcoded colors.
- **Font/ligature picker** (desktop only): font-family selector in the same settings screen; ship 1-2 bundled ligature fonts (e.g. JetBrains Mono) as assets. Desktop-only because RN's text engine has inconsistent ligature support across platforms — no mobile risk since this stays off mobile.

### 4. Split-panes layout (desktop, biggest architectural change)

- Client-layout-only per the "layout split of existing sessions" decision — no server change.
- `useTetherApp` currently assumes **one** active attached session (`sock`, `gen`, singleton ws + emulator), with others detached in the LRU session cache. Split panes need **N concurrently attached sessions**.
- Generalize the single active-session slot into `attachedSessions: Map<id, {sock, emulator, gen}>`; pane layout picks which session IDs are attached, detaching on layout change follows the existing detach path.
- Scope: 2-pane side-by-side split, desktop only, reversible via a "1 pane" toggle back to current tab behavior.

## Error handling & testing

Folded into the implementation plan rather than detailed here — each phase's plan section will cover its own failure modes (e.g. upload endpoint auth/size/path-traversal checks, drag-drop drop-outside-bounds, split-pane detach races) and test approach (unit tests for parser additions in `terminal.test.ts`, following existing patterns for OSC/CSI cases already in that file).

## Out of scope

- Sixel/iTerm2 inline image rendering (flagged during discovery as high effort/high value, but not requested for this pass — revisit separately if wanted).
- True tmux-style multi-PTY-per-session split panes (rejected in favor of layout-split-of-existing-sessions).
- Non-bash shell OSC 7/133 hooks (zsh/fish) — bash-only for this pass since `tether.bashrc` is the only shell hook point that currently exists.
