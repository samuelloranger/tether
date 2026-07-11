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

// Adapt computeInputDelta to a controlled TextInput. The caller MUST set both
// the controlled `value` prop and its previous-value ref to the returned
// `value` — otherwise React Native reverts the native field to the stale
// `value` and the next diff runs against the wrong baseline (emitting spurious
// deletes that corrupt typing/dictation).
export function applyFieldChange(
  prevValue: string,
  next: string,
): { bytes: string; value: string } {
  const d = computeInputDelta(prevValue, next);
  return { bytes: d.bytes, value: d.resetField ? SENT : d.nextPrev };
}
