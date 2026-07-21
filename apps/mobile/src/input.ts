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
