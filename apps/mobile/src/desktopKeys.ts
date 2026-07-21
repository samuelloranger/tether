// Desktop keyboard → PTY bytes. On the Tauri/web build there's a physical
// keyboard, so instead of the mobile utility bar we translate raw `keydown`
// events into the byte sequences a terminal expects and forward them to the
// shell. Returns null for keys we don't handle (let the browser keep them) and
// for pure modifier presses.
//
// Two sentinels are returned for the cases the caller must handle specially:
//   COPY  — Ctrl/Cmd+C with an active text selection (let the browser copy).
//   PASTE — Ctrl/Cmd+V (read the clipboard and send a bracketed paste).

export const COPY = '__TETHER_COPY__';
export const PASTE = '__TETHER_PASTE__';

// Cursor keys (arrows, Home, End) switch between CSI (ESC [ x) and SS3 (ESC O x)
// depending on the app's DECCKM mode. `final` is the last byte (A/B/C/D/H/F).
function cursorKey(final: string, appCursor: boolean): string {
  return `\x1b${appCursor ? 'O' : '['}${final}`;
}

const ARROW_FINAL: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
};

// Navigation keys that don't depend on DECCKM.
const NAV: Record<string, string> = {
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
};

const FKEYS: Record<string, string> = {
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function keyToBytes(e: KeyLike, appCursor = false, isMac = false): string | null {
  const { key } = e;

  // Pure modifier presses produce nothing.
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
    return null;
  }

  // AltGr (reported as Ctrl+Alt on Windows/Linux) composes a printable char —
  // e.g. `@ { } [ ] \` on many EU layouts. Send it verbatim; it must win over
  // the Ctrl-combo handling below, which would otherwise swallow it.
  if (e.ctrlKey && e.altKey && key.length === 1) return key;

  // Clipboard modifier: Cmd on macOS, Ctrl elsewhere. On macOS, Ctrl must stay a
  // pure control modifier (Ctrl+C = SIGINT, Ctrl+V = 0x16), so it must NOT map to
  // copy/paste — only Cmd does. On Windows/Linux there's no Cmd, so Ctrl serves
  // double duty via the copy-vs-SIGINT heuristic below.
  const clip = isMac ? e.metaKey : e.ctrlKey || e.metaKey;

  // Copy only when there's a selection.
  if (clip && (key === 'c' || key === 'C')) {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
    if (sel) return COPY;
    // Windows/Linux: Ctrl+C with no selection is SIGINT. macOS: Cmd+C with no
    // selection is a no-op (Ctrl+C is the SIGINT path, handled as a control byte).
    return isMac ? null : '\x03';
  }
  if (clip && (key === 'v' || key === 'V')) return PASTE;

  // Ctrl+letter → control byte (Ctrl+A = 0x01 … Ctrl+Z = 0x1a). On macOS this is
  // also how Ctrl+C→SIGINT and Ctrl+V→0x16 (verbatim) happen; Cmd is above.
  if (e.ctrlKey && !e.altKey && /^[a-zA-Z]$/.test(key)) {
    return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
  }
  // A few common Ctrl+symbol combos.
  if (e.ctrlKey && !e.altKey) {
    if (key === '[') return '\x1b';
    if (key === ' ') return '\x00'; // Ctrl+Space → NUL
    if (key === '\\') return '\x1c';
    if (key === ']') return '\x1d';
  }

  if (key === 'Enter') return '\r';
  // Word deletion: Alt+Backspace sends readline backward-kill-word (ESC DEL,
  // same Meta- convention as the Alt+Arrow word-motion below); Ctrl+Backspace
  // sends werase (Ctrl+W) for the Windows/Linux habit.
  if (key === 'Backspace') {
    if (e.altKey) return '\x1b\x7f';
    if (e.ctrlKey) return '\x17';
    return '\x7f';
  }
  if (key === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
  if (key === 'Escape') return '\x1b';

  // Alt+Left/Right → readline word-motion (Meta-b/Meta-f), matching the
  // convention terminal emulators use (Terminal.app/iTerm2 send this exact
  // sequence for Option+Left/Right) so it works with bash/readline's default
  // bindings with no user config needed. Up/Down have no word-motion analog,
  // so they fall through to plain cursor motion below.
  if (e.altKey && key === 'ArrowLeft') return '\x1bb';
  if (e.altKey && key === 'ArrowRight') return '\x1bf';

  if (ARROW_FINAL[key]) return cursorKey(ARROW_FINAL[key], appCursor);
  if (key === 'Home') return cursorKey('H', appCursor);
  if (key === 'End') return cursorKey('F', appCursor);
  if (NAV[key]) return NAV[key];
  if (FKEYS[key]) return FKEYS[key];

  // Alt+char → ESC-prefixed (Meta) so word-motion (Alt+B/F) works.
  if (e.altKey && !e.ctrlKey && key.length === 1) return `\x1b${key}`;

  // Any single printable character (letters, digits, symbols, space) with no
  // Ctrl/Meta held: send verbatim.
  if (key.length === 1 && !e.ctrlKey && !e.metaKey) return key;

  return null;
}
