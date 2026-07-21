# Session auto-title — design

Date: 2026-07-21

## Problem

Sessions can be renamed manually (`sessions.name`, `POST /api/sessions/rename`,
drawer shows `s.name || s.id`), but nobody renames every session. A drawer full
of raw UUIDs tells you nothing about which tab is the Claude Code run in
`~/sites/tether` and which is the ssh box. The emulator already parses OSC 0/2
(title) and OSC 7 (cwd) — but only client-side, only for the *attached*
session, so background tabs have nothing to show.

## Goal

Every session gets a useful display title with zero user effort. Manual rename
still wins. Titles are computed **server-side** so background sessions and
every client (mobile, desktop) see the same thing without a live WebSocket.

## Title precedence

For display, the client uses the first non-empty of:

1. `name` — manual rename (DB column, unchanged).
2. `auto_title` — new server-computed field, itself the first non-empty of:
   a. **OSC 0/2 title** last emitted by the PTY (vim, Claude Code, ssh set these).
   b. **cwd basename** from the server's live cwd tracking (OSC 7), e.g. `tether`.
   c. **`command`** column (e.g. `bash`).
3. `id` (existing last resort).

Rationale: apps that set a title know best; otherwise the directory name is the
most human-meaningful signal; the shell command is a floor that always exists.

## Architecture

### Server

- **OSC 0/2 parsing in the PTY pipe.** The server already parses OSC 7
  server-side for the diff view's live cwd (`pty.ts` data pipe). Extend the
  same scanner to also capture OSC 0 and OSC 2 payloads
  (`\x1b]0;<title>\x07` / `\x1b]2;<title>\x1b\\`, both BEL and ST terminators).
  Store as in-memory `oscTitle` on the `SessionInstance` — not persisted;
  it is re-asserted by the app whenever it redraws, and an empty value after a
  server restart simply falls through to cwd/command.
- **Sanitization.** Strip control characters, trim, cap at 128 chars. Ignore
  empty payloads (`\x1b]0;\x07` clears the title back to fallbacks — matches
  xterm semantics).
- **`auto_title` in `GET /api/sessions`.** `listSessions()` result is joined
  with the in-memory holders: for each running session, compute
  `auto_title = oscTitle || basename(liveCwd) || command`. Stopped sessions get
  `auto_title = command` (no live state). No schema change — the field is
  computed, never stored.
- **Live update frame.** Add `{ type: 'title', title: string }` to
  `SessionFrame`, broadcast when the computed `auto_title` *changes* (debounced
  by value comparison, like the diff frame). The attached client updates its
  tab label immediately; background tabs pick changes up through the existing
  session-list poll that already drives activity badges.

### Mobile / desktop client

- Drawer (`SessionDrawer.tsx`) and desktop session navigator render
  `s.name || s.auto_title || s.id`. Manual rename UI unchanged.
- Session list state (`useTetherApp`) stores `auto_title` from
  `GET /api/sessions` and patches it from `title` frames for the attached
  session.
- Middle-truncate long titles (`numberOfLines={1}` already present).

## Error handling

- Malformed/oversized OSC payloads: discard (parser already tolerates garbage;
  cap the OSC accumulation buffer as the client emulator does).
- Title containing only whitespace/controls after sanitization: treat as empty,
  fall through.
- Server restart: `oscTitle`/`liveCwd` empty until the shell's next prompt or
  app redraw; `auto_title` degrades to `command` meanwhile. Acceptable.

## Testing

- Unit tests (bun test, server): OSC 0/2 extraction from a byte stream in
  chunks split mid-sequence; BEL vs ST terminators; sanitization; precedence
  (oscTitle > cwd basename > command); empty-title clear.
- Unit test: `title` frame broadcast fires only on value change.
- Client: precedence rendering test for the drawer label helper.

## Out of scope (YAGNI)

- Persisting auto-titles across server restarts.
- Foreground-process detection via `/proc` — OSC title covers the interesting
  apps already.
- Per-client title overrides; renames stay global (existing behavior).
