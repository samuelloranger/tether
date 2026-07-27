// The mobile Ctrl control arms one terminal-style modifier for the next input.
// Apply it where the bytes actually arrive, rather than depending on a separate
// native keypress event being delivered in a particular order.
export function applyCtrlModifier(armed: boolean, bytes: string): { bytes: string; consumed: boolean } {
  if (!armed || !bytes) return { bytes, consumed: false };
  if (bytes.length === 1 && /^[a-zA-Z]$/.test(bytes)) {
    return {
      bytes: String.fromCharCode(bytes.toUpperCase().charCodeAt(0) - 64),
      consumed: true,
    };
  }
  return { bytes, consumed: true };
}

// Ctrl also has to reach whole keys, not just letters: the utility bar and the
// D-pad send Tab, Esc, arrows and Home/End/PgUp/PgDn/Del as escape sequences,
// and a physical keyboard sends the same. Terminals encode a modified cursor or
// tilde key by injecting parameter 5 (Ctrl) into the CSI form, e.g. Right is
// ESC[C or ESC O C unmodified but ESC[1;5C with Ctrl, and Del is ESC[3~ but
// ESC[3;5~. SS3 (application-cursor) sequences have no modifier form, so they
// are rewritten to CSI here. Keys with no Ctrl encoding at all (Tab, Esc) pass
// through unchanged but still consume the armed modifier, so it never stays
// stuck armed and silently rewrites the next typed letter.
const ESC = '\x1b';
const CURSOR_FINALS = 'ABCDHF';

export function applyCtrlToKey(armed: boolean, bytes: string): { bytes: string; consumed: boolean } {
  if (!armed || !bytes) return { bytes, consumed: false };
  // CSI/SS3 cursor key: ESC[X or ESC O X, X = A-D (arrows) or H/F (Home/End).
  if (
    bytes.length === 3 &&
    bytes[0] === ESC &&
    (bytes[1] === '[' || bytes[1] === 'O') &&
    CURSOR_FINALS.includes(bytes[2])
  ) {
    return { bytes: `${ESC}[1;5${bytes[2]}`, consumed: true };
  }
  // CSI tilde key: ESC[N~ (3 = Del, 5 = PgUp, 6 = PgDn).
  if (bytes.length > 3 && bytes[0] === ESC && bytes[1] === '[' && bytes.endsWith('~')) {
    const params = bytes.slice(2, -1);
    if (/^\d+$/.test(params)) return { bytes: `${ESC}[${params};5~`, consumed: true };
  }
  return applyCtrlModifier(armed, bytes);
}

// Hold-backspace word deletion. Holding Backspace yields one \x7f per repeat and
// nothing more — the keyboard's own word-delete acceleration never reaches us,
// and the PTY owns the line state so the client cannot know word boundaries.
// Detect the streak instead: after STREAK_THRESHOLD rapid consecutive deletes,
// upgrade each further one to Ctrl+W (tty werase) so the shell erases whole
// words. Any other byte, or a gap of STREAK_GAP_MS, breaks the streak.
export interface BackspaceStreak {
  count: number;
  lastAt: number;
}

export const EMPTY_STREAK: BackspaceStreak = { count: 0, lastAt: 0 };
export const STREAK_GAP_MS = 150;
export const STREAK_THRESHOLD = 15;

export function applyBackspaceStreak(
  streak: BackspaceStreak,
  bytes: string,
  now: number,
): { streak: BackspaceStreak; bytes: string } {
  // Anything that is not a delete breaks the streak and passes through.
  if (bytes !== '\x7f') return { streak: EMPTY_STREAK, bytes };
  const count = now - streak.lastAt < STREAK_GAP_MS ? streak.count + 1 : 1;
  return { streak: { count, lastAt: now }, bytes: count > STREAK_THRESHOLD ? '\x17' : '\x7f' };
}
