import { afterEach, describe, expect, it } from 'bun:test';
import { COPY, PASTE, keyToBytes, type KeyLike } from './desktopKeys';

function k(key: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

// Stub window.getSelection for the copy-vs-SIGINT branch.
function withSelection(text: string, fn: () => void) {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  g.window = { getSelection: () => ({ toString: () => text }) };
  try {
    fn();
  } finally {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  }
}

afterEach(() => {
  // Ensure no window leaks between tests (some tests set it).
  const g = globalThis as { window?: unknown };
  if (g.window && typeof (g.window as { getSelection?: unknown }).getSelection === 'function') {
    delete g.window;
  }
});

describe('keyToBytes — printable', () => {
  it('passes single letters through verbatim', () => {
    expect(keyToBytes(k('a'))).toBe('a');
    expect(keyToBytes(k('Z'))).toBe('Z');
  });
  it('passes digits, symbols and space through', () => {
    expect(keyToBytes(k('7'))).toBe('7');
    expect(keyToBytes(k('$'))).toBe('$');
    expect(keyToBytes(k(' '))).toBe(' ');
  });
});

describe('keyToBytes — named keys', () => {
  it('maps Enter/Backspace/Escape', () => {
    expect(keyToBytes(k('Enter'))).toBe('\r');
    expect(keyToBytes(k('Backspace'))).toBe('\x7f');
    expect(keyToBytes(k('Escape'))).toBe('\x1b');
  });
  it('maps Tab and Shift+Tab (back-tab)', () => {
    expect(keyToBytes(k('Tab'))).toBe('\t');
    expect(keyToBytes(k('Tab', { shiftKey: true }))).toBe('\x1b[Z');
  });
  it('maps arrows as CSI in normal cursor mode', () => {
    expect(keyToBytes(k('ArrowUp'))).toBe('\x1b[A');
    expect(keyToBytes(k('ArrowDown'))).toBe('\x1b[B');
    expect(keyToBytes(k('ArrowRight'))).toBe('\x1b[C');
    expect(keyToBytes(k('ArrowLeft'))).toBe('\x1b[D');
  });
  it('maps arrows as SS3 in application-cursor mode (DECCKM)', () => {
    expect(keyToBytes(k('ArrowUp'), true)).toBe('\x1bOA');
    expect(keyToBytes(k('ArrowDown'), true)).toBe('\x1bOB');
    expect(keyToBytes(k('ArrowRight'), true)).toBe('\x1bOC');
    expect(keyToBytes(k('ArrowLeft'), true)).toBe('\x1bOD');
  });
  it('maps Home/End per cursor mode', () => {
    expect(keyToBytes(k('Home'))).toBe('\x1b[H');
    expect(keyToBytes(k('End'))).toBe('\x1b[F');
    expect(keyToBytes(k('Home'), true)).toBe('\x1bOH');
    expect(keyToBytes(k('End'), true)).toBe('\x1bOF');
  });
  it('maps navigation + editing keys (cursor-mode independent)', () => {
    expect(keyToBytes(k('PageUp'))).toBe('\x1b[5~');
    expect(keyToBytes(k('PageDown'))).toBe('\x1b[6~');
    expect(keyToBytes(k('Delete'))).toBe('\x1b[3~');
    expect(keyToBytes(k('Insert'))).toBe('\x1b[2~');
    // PageUp/Delete stay CSI even in app-cursor mode.
    expect(keyToBytes(k('PageUp'), true)).toBe('\x1b[5~');
  });
  it('maps function keys', () => {
    expect(keyToBytes(k('F1'))).toBe('\x1bOP');
    expect(keyToBytes(k('F5'))).toBe('\x1b[15~');
    expect(keyToBytes(k('F12'))).toBe('\x1b[24~');
  });
});

describe('keyToBytes — Ctrl combos', () => {
  it('maps Ctrl+letter to control bytes', () => {
    expect(keyToBytes(k('a', { ctrlKey: true }))).toBe('\x01');
    expect(keyToBytes(k('d', { ctrlKey: true }))).toBe('\x04');
    expect(keyToBytes(k('z', { ctrlKey: true }))).toBe('\x1a');
  });
  it('is case-insensitive for Ctrl+letter', () => {
    expect(keyToBytes(k('A', { ctrlKey: true }))).toBe('\x01');
  });
  it('maps a few Ctrl+symbol combos', () => {
    expect(keyToBytes(k('[', { ctrlKey: true }))).toBe('\x1b');
    expect(keyToBytes(k(' ', { ctrlKey: true }))).toBe('\x00');
    expect(keyToBytes(k('\\', { ctrlKey: true }))).toBe('\x1c');
    expect(keyToBytes(k(']', { ctrlKey: true }))).toBe('\x1d');
  });
});

describe('keyToBytes — clipboard', () => {
  it('Ctrl+C with a selection returns COPY (browser handles copy)', () => {
    withSelection('some selected text', () => {
      expect(keyToBytes(k('c', { ctrlKey: true }))).toBe(COPY);
    });
  });
  it('Ctrl+C with no selection sends SIGINT', () => {
    withSelection('', () => {
      expect(keyToBytes(k('c', { ctrlKey: true }))).toBe('\x03');
    });
  });
  it('Cmd+C (macOS) with a selection returns COPY', () => {
    withSelection('x', () => {
      expect(keyToBytes(k('c', { metaKey: true }))).toBe(COPY);
    });
  });
  it('Ctrl+V / Cmd+V return PASTE', () => {
    expect(keyToBytes(k('v', { ctrlKey: true }))).toBe(PASTE);
    expect(keyToBytes(k('v', { metaKey: true }))).toBe(PASTE);
  });

  // macOS: Cmd is the clipboard modifier; Ctrl stays a pure control modifier.
  describe('macOS (isMac = true)', () => {
    it('Ctrl+C is always SIGINT, even with a selection (Cmd handles copy)', () => {
      withSelection('some selected text', () => {
        expect(keyToBytes(k('c', { ctrlKey: true }), false, true)).toBe('\x03');
      });
    });
    it('Cmd+C with a selection returns COPY', () => {
      withSelection('some selected text', () => {
        expect(keyToBytes(k('c', { metaKey: true }), false, true)).toBe(COPY);
      });
    });
    it('Cmd+C with no selection is a no-op (not SIGINT)', () => {
      withSelection('', () => {
        expect(keyToBytes(k('c', { metaKey: true }), false, true)).toBeNull();
      });
    });
    it('Ctrl+V sends 0x16 (verbatim insert), Cmd+V pastes', () => {
      expect(keyToBytes(k('v', { ctrlKey: true }), false, true)).toBe('\x16');
      expect(keyToBytes(k('v', { metaKey: true }), false, true)).toBe(PASTE);
    });
  });
});

describe('keyToBytes — Alt (Meta) prefixing', () => {
  it('Alt+letter sends ESC-prefixed for word motion', () => {
    expect(keyToBytes(k('b', { altKey: true }))).toBe('\x1bb');
    expect(keyToBytes(k('f', { altKey: true }))).toBe('\x1bf');
  });
  it('Alt+ArrowLeft/Right send readline word-motion (ESC b / ESC f), not plain cursor motion', () => {
    expect(keyToBytes(k('ArrowLeft', { altKey: true }))).toBe('\x1bb');
    expect(keyToBytes(k('ArrowRight', { altKey: true }))).toBe('\x1bf');
  });
  it('Alt+ArrowLeft/Right word-motion is independent of DECCKM (app-cursor mode)', () => {
    expect(keyToBytes(k('ArrowLeft', { altKey: true }), true)).toBe('\x1bb');
    expect(keyToBytes(k('ArrowRight', { altKey: true }), true)).toBe('\x1bf');
  });
  it('Alt+ArrowUp/Down still send plain cursor motion (no word-motion analog)', () => {
    expect(keyToBytes(k('ArrowUp', { altKey: true }))).toBe('\x1b[A');
    expect(keyToBytes(k('ArrowDown', { altKey: true }))).toBe('\x1b[B');
  });
  it('macOS Option+Left/Right (reported as altKey, isMac=true) sends the same word-motion', () => {
    expect(keyToBytes(k('ArrowLeft', { altKey: true }), false, true)).toBe('\x1bb');
    expect(keyToBytes(k('ArrowRight', { altKey: true }), false, true)).toBe('\x1bf');
  });
});

describe('keyToBytes — AltGr (Ctrl+Alt) composed characters', () => {
  it('sends the composed printable char verbatim (EU layouts)', () => {
    // AltGr is reported as ctrlKey+altKey with key = the composed glyph.
    expect(keyToBytes(k('@', { ctrlKey: true, altKey: true }))).toBe('@');
    expect(keyToBytes(k('{', { ctrlKey: true, altKey: true }))).toBe('{');
    expect(keyToBytes(k('\\', { ctrlKey: true, altKey: true }))).toBe('\\');
  });
  it('AltGr wins over Ctrl-combo handling', () => {
    // 'e' via AltGr (€ on some layouts arrives as a longer key, but a 1-char
    // key like 'e' must not become Ctrl-E control byte).
    expect(keyToBytes(k('e', { ctrlKey: true, altKey: true }))).toBe('e');
  });
});

describe('keyToBytes — ignored keys', () => {
  it('returns null for pure modifier presses', () => {
    expect(keyToBytes(k('Control'))).toBeNull();
    expect(keyToBytes(k('Shift'))).toBeNull();
    expect(keyToBytes(k('Alt'))).toBeNull();
    expect(keyToBytes(k('Meta'))).toBeNull();
  });
  it('returns null for unhandled named keys', () => {
    expect(keyToBytes(k('CapsLock'))).toBeNull();
    expect(keyToBytes(k('Dead'))).toBeNull();
  });
  it('does not send bare Cmd+letter (left to the OS)', () => {
    // Cmd+A/S/etc. are not control bytes and not printable-with-no-mod.
    expect(keyToBytes(k('a', { metaKey: true }))).toBeNull();
  });
});
