// The 12-char Crockford base32 enrollment code, on the desktop side. Mirrors
// `crates/tether-core/src/noise/code.rs` (normalize + grouped) so the code the
// user types here folds to exactly what the Rust `code::normalize` expects
// before it reaches `core_noise_pair`. Desktop has no camera, so this is the
// only way a code arrives — keep it forgiving on input, strict on submit.

// Crockford base32: A–Z minus the ambiguous I, L, O, U, plus the digits.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 12;

// Uppercase, then fold the look-alikes the way Crockford reading does: O→0 and
// I/L→1. Everything else is returned uppercased and checked against the alphabet
// by the caller. Matches the Rust folding exactly (U is not folded — it is not
// in the alphabet, so it is simply rejected).
function foldChar(ch: string): string {
  const upper = ch.toUpperCase();
  if (upper === 'O') return '0';
  if (upper === 'I' || upper === 'L') return '1';
  return upper;
}

/**
 * Strict normalization for submit: fold case + look-alikes, strip dashes and
 * spaces, and require exactly 12 in-alphabet characters. Returns the canonical
 * 12-char code, or `null` if the input is not a complete, valid code.
 */
export function normalizePairingCode(input: string): string | null {
  let out = '';
  for (const ch of input) {
    if (ch === '-' || ch === ' ') continue;
    const folded = foldChar(ch);
    if (!CODE_ALPHABET.includes(folded)) return null;
    out += folded;
  }
  return out.length === CODE_LEN ? out : null;
}

/** Group a code into 4·4·4 blocks joined by dashes: `7QF4-KM9P-X3TV`. */
export function groupPairingCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += 4) {
    groups.push(code.slice(i, i + 4));
  }
  return groups.join('-');
}

/**
 * Forgiving live formatting for the input box: fold case + look-alikes, drop
 * anything not in the alphabet (including half-typed dashes/spaces), cap at 12
 * characters, and regroup 4·4·4. Lets the user paste `7qf4km9px3tv`, `7QF4 KM9P
 * X3TV`, or type freely and always see the grouped, uppercased form.
 */
export function formatPairingInput(input: string): string {
  let cleaned = '';
  for (const ch of input) {
    if (cleaned.length >= CODE_LEN) break;
    if (ch === '-' || ch === ' ') continue;
    const folded = foldChar(ch);
    if (CODE_ALPHABET.includes(folded)) cleaned += folded;
  }
  return groupPairingCode(cleaned);
}

/** True once the input holds a complete, valid 12-char code. */
export function isCompletePairingCode(input: string): boolean {
  return normalizePairingCode(input) !== null;
}
