// Desktop keyboard → PTY bytes. On the Tauri/web build there's a physical
// keyboard, so instead of the mobile utility bar we translate raw `keydown`
// events into the byte sequences a terminal expects and forward them to the
// shell. Returns null for keys we don't handle (let the browser keep them) and
// for pure modifier presses.
//
// Two sentinels are returned for the cases the caller must handle specially:
//   COPY         — Ctrl/Cmd+C with an active text selection (caller writes the clipboard).
//   PASTE        — Ctrl/Cmd+V or Shift+Insert (read the clipboard and send a bracketed paste).
//   SELECT_ALL   — Ctrl+A on Windows/Linux, Cmd+A on macOS (Ctrl+A stays BOL on Mac).
//   NEW_TERMINAL — Ctrl/Cmd+T (open a new session).
//   FONT_LARGER  — Ctrl/Cmd+= or + (increase terminal font).
//   FONT_SMALLER — Ctrl/Cmd+- (decrease terminal font).
//
// `hasSelection` must come from the xterm selection (terminal.getSelection() /
// onSelection), not window.getSelection() — xterm paints selection on canvas/
// WebGL, so the DOM Selection API is always empty for terminal text.
//
// Desktop app shortcuts AND navigation keys are handled in TerminalView's
// attachCustomKeyEventHandler (xterm's textarea owns focus). The window-level
// handler is only a fallback when focus is on body. Nav keys must use event.key
// there — xterm's own mapping is keyCode-based and can silently drop arrows.

export const COPY = '__TETHER_COPY__';
export const PASTE = '__TETHER_PASTE__';
export const SELECT_ALL = '__TETHER_SELECT_ALL__';
export const NEW_TERMINAL = '__TETHER_NEW_TERMINAL__';
export const FONT_LARGER = '__TETHER_FONT_LARGER__';
export const FONT_SMALLER = '__TETHER_FONT_SMALLER__';

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

const LEGACY_ARROW: Record<string, string> = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
};

// Some webviews (WKWebView / WebKitGTK) report arrows as key="Unidentified"
// with keyCode=0. event.code (and a keyCode fallback) still identify them.
const CODE_TO_KEY: Record<string, string> = {
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};

const KEYCODE_TO_KEY: Record<number, string> = {
  33: 'PageUp',
  34: 'PageDown',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  45: 'Insert',
  46: 'Delete',
  112: 'F1',
  113: 'F2',
  114: 'F3',
  115: 'F4',
  116: 'F5',
  117: 'F6',
  118: 'F7',
  119: 'F8',
  120: 'F9',
  121: 'F10',
  122: 'F11',
  123: 'F12',
};

/** Normalize legacy webview key names (Left) to ArrowLeft before mapping. */
export function normalizeKeyName(key: string): string {
  return LEGACY_ARROW[key] ?? key;
}

// `keyToBytes` doesn't encode modifier params (Ctrl+Right → `\x1b[1;5C`) for nav
// keys — xterm's own keyCode-based handling already does that correctly. Only
// bypass xterm when its handling is the thing that's actually broken (raw
// `key` unusable), so modified nav keys keep working through xterm otherwise.
export function keyNeedsFallback(e: { key: string }): boolean {
  return !e.key || normalizeKeyName(e.key) === 'Unidentified';
}

/**
 * Resolve a usable key name from a keyboard event. Prefer `key`, then `code`,
 * then legacy `keyCode` — Tauri/WebKit sometimes leaves key/keyCode unusable
 * for arrows while still setting `code`.
 */
export function resolveKeyboardKey(e: { key: string; code?: string; keyCode?: number }): string {
  const fromKey = normalizeKeyName(e.key);
  if (fromKey && fromKey !== 'Unidentified') return fromKey;
  if (e.code && CODE_TO_KEY[e.code]) return CODE_TO_KEY[e.code];
  if (e.keyCode && KEYCODE_TO_KEY[e.keyCode]) return KEYCODE_TO_KEY[e.keyCode];
  return fromKey;
}

// Navigation keys xterm maps via deprecated keyCode. When its helper textarea
// owns focus, the window-level desktop handler skips TEXTAREA — so these must
// be captured (capture-phase) using resolveKeyboardKey and forwarded to the PTY.
export function isTerminalNavKey(key: string): boolean {
  const normalized = normalizeKeyName(key);
  return (
    normalized in ARROW_FINAL ||
    normalized === 'Home' ||
    normalized === 'End' ||
    normalized in NAV ||
    normalized in FKEYS
  );
}

export interface KeyLike {
  key: string;
  code?: string;
  keyCode?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function keyToBytes(
  e: KeyLike,
  appCursor = false,
  isMac = false,
  hasSelection = false,
): string | null {
  const key = resolveKeyboardKey(e);

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

  // Copy only when there's a selection (from xterm, passed by the caller).
  // Ctrl+Shift+C is the explicit copy chord on Win/Linux terminals — never SIGINT.
  if (clip && (key === 'c' || key === 'C')) {
    if (hasSelection) return COPY;
    if (e.shiftKey) return null;
    // Windows/Linux: Ctrl+C with no selection is SIGINT. macOS: Cmd+C with no
    // selection is a no-op (Ctrl+C is the SIGINT path, handled as a control byte).
    return isMac ? null : '\x03';
  }
  if (clip && (key === 'v' || key === 'V')) return PASTE;
  // Select all: Ctrl+A on Windows/Linux, Cmd+A on macOS. On macOS Ctrl+A must
  // stay beginning-of-line (\x01), so only Meta maps to SELECT_ALL there.
  if (isMac ? e.metaKey : e.ctrlKey) {
    if (key === 'a' || key === 'A') return SELECT_ALL;
  }
  // Shift+Insert pastes on Linux/Windows terminals.
  if (e.shiftKey && key === 'Insert') return PASTE;
  // App chrome shortcuts (same clip modifier as copy/paste).
  if (clip && (key === 't' || key === 'T')) return NEW_TERMINAL;
  if (clip && (key === '=' || key === '+' || key === 'Add')) return FONT_LARGER;
  if (clip && (key === '-' || key === '_' || key === 'Subtract')) return FONT_SMALLER;

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
