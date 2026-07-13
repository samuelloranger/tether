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

const ARROWS: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

const NAV: Record<string, string> = {
  Home: '\x1b[H',
  End: '\x1b[F',
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

export function keyToBytes(e: KeyLike): string | null {
  const { key } = e;

  // Pure modifier presses produce nothing.
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
    return null;
  }

  const mod = e.ctrlKey || e.metaKey;

  // Clipboard: copy only when there's a selection, otherwise Ctrl+C is SIGINT.
  if (mod && (key === 'c' || key === 'C')) {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
    if (sel) return COPY;
    return '\x03'; // Ctrl+C → SIGINT
  }
  if (mod && (key === 'v' || key === 'V')) return PASTE;

  // Ctrl+letter → control byte (Ctrl+A = 0x01 … Ctrl+Z = 0x1a). Cmd is left for
  // the OS on macOS (Cmd+C/V handled above); only Ctrl maps to control codes.
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
  if (key === 'Backspace') return '\x7f';
  if (key === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
  if (key === 'Escape') return '\x1b';

  if (ARROWS[key]) return ARROWS[key];
  if (NAV[key]) return NAV[key];
  if (FKEYS[key]) return FKEYS[key];

  // Alt+char → ESC-prefixed (Meta) so word-motion (Alt+B/F) works.
  if (e.altKey && !e.ctrlKey && key.length === 1) return `\x1b${key}`;

  // Any single printable character (letters, digits, symbols, space) with no
  // Ctrl/Meta held: send verbatim.
  if (key.length === 1 && !e.ctrlKey && !e.metaKey) return key;

  return null;
}
