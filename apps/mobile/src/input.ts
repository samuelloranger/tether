// Zero-width sentinel kept in the hidden capture field so it's never "empty" —
// lets iOS fire onChangeText for Backspace even with nothing typed yet, and
// gives the delta a stable prefix to diff against.
export const SENT = '​';

export interface InputDelta {
  // Bytes to forward to the PTY: backspaces (\x7f) first, then inserted text.
  // Empty string means nothing to send.
  bytes: string;
  // The value the caller should store as the new "previous value".
  nextPrev: string;
  // When true, the caller must force the field value back to SENT.
  resetField: boolean;
}

// Turn a capture-field mutation (prev -> next) into PTY bytes. Both prev and a
// well-formed next start with SENT. Covers typing (insert 1), dictation /
// swipe (insert a block), live dictation replacement and autocorrect
// (delete N + insert M), and Backspace (delete 1, or delete-at-empty).
export function computeInputDelta(prev: string, next: string): InputDelta {
  // Sentinel eaten: the field lost its SENT prefix, so Backspace fired with no
  // real content. Send one delete and re-anchor the field.
  if (next === '' || !next.startsWith(SENT)) {
    return { bytes: '\x7f', nextPrev: SENT, resetField: true };
  }

  // Longest common prefix; everything after it in prev was removed and
  // everything after it in next was inserted.
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;

  const removed = prev.length - p;
  const inserted = next.slice(p);
  return {
    bytes: '\x7f'.repeat(removed) + inserted,
    nextPrev: next,
    resetField: false,
  };
}

// The mobile Ctrl control arms one terminal-style modifier for the next input
// delta. Apply it here — where the actual text arrives — instead of depending
// on a separate native keypress event to be delivered in a particular order.
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

// Ctrl also has to reach the keys that never pass through the capture field —
// everything the mobile utility bar and the D-pad send directly (Tab, Esc,
// arrows, Home/End/PgUp/PgDn/Del). Terminals encode a modified cursor or
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

// Hold-backspace word deletion: the capture field is pinned to a sentinel, so
// when iOS/Android keyboards accelerate into word-delete mode the field still
// only ever yields single-character deletes. The PTY owns the line state, so
// the client can't know word boundaries — instead, detect the streak: after
// STREAK_THRESHOLD rapid consecutive single deletes, upgrade each further
// delete to Ctrl+W (tty werase) so the shell erases whole words.
//
// Only empty-buffer deletes (Backspace against the re-anchored sentinel, i.e.
// computeInputDelta's resetField branch) count toward the streak. A delete
// that consumes locally-typed text still living in the capture field maps 1:1
// to a character the field actually removed, so upgrading it to Ctrl+W would
// erase whole words on the PTY while the field only dropped one char. Gating
// on the empty buffer keeps freshly-typed text char-precise and reserves
// word-delete for content that isn't locally buffered (recalled history, long
// lines, program output).
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
  fromEmptyBuffer: boolean,
  now: number,
): { streak: BackspaceStreak; bytes: string } {
  // Anything but an empty-buffer delete (typing, dictation, or a delete that
  // consumed local text) breaks the streak and passes through unchanged.
  if (bytes !== '\x7f' || !fromEmptyBuffer) return { streak: EMPTY_STREAK, bytes };
  const count = now - streak.lastAt < STREAK_GAP_MS ? streak.count + 1 : 1;
  return { streak: { count, lastAt: now }, bytes: count > STREAK_THRESHOLD ? '\x17' : '\x7f' };
}

// Adapt computeInputDelta to a controlled TextInput. The caller MUST set both
// the controlled `value` prop and its previous-value ref to the returned
// `value` — otherwise React Native reverts the native field to the stale
// `value` and the next diff runs against the wrong baseline (emitting spurious
// deletes that corrupt typing/dictation). `fromEmptyBuffer` mirrors the delta's
// reset (Backspace with no local content) — see applyBackspaceStreak.
export function applyFieldChange(
  prevValue: string,
  next: string,
): { bytes: string; value: string; fromEmptyBuffer: boolean } {
  const d = computeInputDelta(prevValue, next);
  return { bytes: d.bytes, value: d.resetField ? SENT : d.nextPrev, fromEmptyBuffer: d.resetField };
}
