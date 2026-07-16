# OSC 52 clipboard + OSC 10/11 color query reply

## Goal

Close two silent-failure gaps in the mobile VT emulator (`apps/mobile/src/terminal.ts`):

- OSC 52: vim/tmux "yank to system clipboard" never reaches the phone clipboard.
- OSC 10/11: TUI apps (fzf, lazygit, nvim, btop) that query terminal fg/bg to pick a light/dark theme get no reply and may guess wrong.

## Design

Both live in `dispatchOsc()` (terminal.ts:638), which already parses `ESC ] Ps ; Pt <terminator>` sequences. The emulator stays platform-agnostic — no `expo-clipboard` import inside `terminal.ts` — by adding two optional hooks alongside the existing `onReply`:

```typescript
onClipboardWrite: ((text: string) => void) | null = null;
onClipboardRead: (() => Promise<string>) | null = null;
```

`useTetherApp.tsx` wires these per-session in `entryFor()`, the same place `term.onReply` is wired today:

```typescript
term.onClipboardWrite = (text) => { void Clipboard.setStringAsync(text).catch(() => {}); };
term.onClipboardRead = () => Clipboard.getStringAsync();
```

Both reuse the `expo-clipboard` dependency already used for selection copy/paste (`useTetherApp.tsx:845,951`) — no new package.

### OSC 52 (`ps === '52'`)

`Pt` format is `<buffer-letters>;<base64-or-?>`. Buffer letter is ignored — mobile has no separate primary-selection concept, so `c`/`p`/`s`/`0`-`7` all map to the one device clipboard.

- Write: `ESC]52;c;<base64>BEL` → base64-decode → `this.onClipboardWrite?.(text)`.
- Query: `ESC]52;c;?BEL` → `this.onClipboardRead?.()` → on resolve, `this.onReply?.(\`\x1b]52;c;${b64}\x1b\\\`)`. Async and fire-and-forget; the reply lands whenever the clipboard promise settles, same as a real terminal's asynchronous OSC 52 round-trip.
- No toast/notification on success, matching the existing silent `copySelection()` behavior.

### OSC 10/11 (`ps === '10'` / `ps === '11'`)

Query-only: reply when `pt === '?'`. The "set fg/bg" direction is out of scope — themes are fixed Catppuccin flavors; a remote app should not be able to override them.

Reply uses the emulator's live `DEFAULT_FG`/`DEFAULT_BG` (already tracked via `setTheme()`, terminal.ts:90-91), converted from `#rrggbb` to xterm's `rgb:rrrr/gggg/bbbb` format (each hex byte doubled). Terminator is ST (`\x1b\\`), matching how the parser already expects OSC sequences to close (terminal.ts:338).

### Base64 encode/decode

Uses global `atob`/`btoa`. Bun (the test runner) provides these natively. Recent Hermes (RN 0.86 / Expo SDK 57) also provides them natively per current documentation — no polyfill package needed. **This must be verified on an actual device/simulator during implementation**, not assumed from docs alone; if absent, fall back to a small manual base64 helper local to `terminal.ts`.

## Error handling and testing

- Malformed base64 in an OSC 52 write, or a rejected clipboard read/write promise: silently no-ops, matching how other malformed OSC payloads (bad OSC 7 `file://` URI, etc.) already fail soft in `dispatchOsc`.
- A background (non-active) session's `onClipboardRead`/`onClipboardWrite`/`onReply` calls have nowhere useful to go, same as today's `onReply` — the existing "only forward if `id === activeIdRef.current`" guard in `entryFor()` covers this without new logic.
- Extend `apps/mobile/src/terminal.test.ts` (existing pattern, no new test infra): feed OSC 52 write/query and OSC 10/11 query byte sequences directly into a `TerminalEmulator`, assert `onClipboardWrite`/`onClipboardRead`/`onReply` fire with the correct decoded/encoded payloads and correct terminator.
