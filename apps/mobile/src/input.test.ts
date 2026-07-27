// Run: bun run src/input.test.ts  (from apps/mobile)
import * as input from './input';
import { applyBackspaceStreak, applyCtrlToKey, EMPTY_STREAK, STREAK_THRESHOLD } from './input';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

// --- applyCtrlModifier: the armed Ctrl applied to a plain character ---
{
  const applyCtrlModifier = (
    input as {
      applyCtrlModifier?: (armed: boolean, bytes: string) => { bytes: string; consumed: boolean };
    }
  ).applyCtrlModifier;
  eq(applyCtrlModifier?.(true, 'c'), { bytes: String.fromCharCode(3), consumed: true }, 'Ctrl+C emits SIGINT');
  eq(applyCtrlModifier?.(true, 'V'), { bytes: String.fromCharCode(22), consumed: true }, 'Ctrl+V emits SYN');
  eq(
    applyCtrlModifier?.(true, 'hello'),
    { bytes: 'hello', consumed: true },
    'Ctrl disarms without rewriting dictated text',
  );
  eq(
    applyCtrlModifier?.(false, 'c'),
    { bytes: 'c', consumed: false },
    'plain text remains unmodified without Ctrl',
  );
}

// --- applyCtrlToKey: the armed Ctrl applied to whole keys ---
// Escape sequences from the utility bar, the D-pad and a physical keyboard must
// pick up CSI parameter 5, and every key must consume the modifier so it can
// never stay armed and silently rewrite the next typed letter.
{
  eq(applyCtrlToKey(true, '\x1b[C'), { bytes: '\x1b[1;5C', consumed: true }, 'Ctrl+Right (CSI)');
  eq(
    applyCtrlToKey(true, '\x1bOC'),
    { bytes: '\x1b[1;5C', consumed: true },
    'Ctrl+Right rewrites SS3 to CSI (SS3 has no modifier form)',
  );
  eq(applyCtrlToKey(true, '\x1b[H'), { bytes: '\x1b[1;5H', consumed: true }, 'Ctrl+Home');
  eq(applyCtrlToKey(true, '\x1b[3~'), { bytes: '\x1b[3;5~', consumed: true }, 'Ctrl+Del');
  eq(applyCtrlToKey(true, '\x1b[6~'), { bytes: '\x1b[6;5~', consumed: true }, 'Ctrl+PgDn');
  eq(
    applyCtrlToKey(true, '\t'),
    { bytes: '\t', consumed: true },
    'Tab has no Ctrl encoding but still disarms, so Ctrl never sticks',
  );
  eq(applyCtrlToKey(true, 'c'), { bytes: String.fromCharCode(3), consumed: true }, 'Ctrl+C');
  eq(applyCtrlToKey(false, '\x1b[C'), { bytes: '\x1b[C', consumed: false }, 'unarmed passthrough');
}

// --- applyBackspaceStreak: hold-backspace accelerates to word delete ---

// Below threshold every delete passes through as a single-character delete.
{
  let s = EMPTY_STREAK;
  for (let i = 0; i < STREAK_THRESHOLD; i++) {
    const r = applyBackspaceStreak(s, '\x7f', 1000 + i * 100);
    eq(r.bytes, '\x7f', `streak pass-through at ${i}`);
    s = r.streak;
  }
}

// Past threshold each further delete becomes Ctrl+W (tty werase).
{
  let last = { streak: EMPTY_STREAK, bytes: '' };
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    last = applyBackspaceStreak(last.streak, '\x7f', 1000 + i * 100);
  }
  eq(last.bytes, '\x17', 'streak upgrades to word delete past threshold');
}

// A pause longer than STREAK_GAP_MS means the user stopped holding.
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', 1000 + i * 100));
  }
  const r = applyBackspaceStreak(s, '\x7f', 100000);
  eq(r.bytes, '\x7f', 'gap resets streak to char delete');
}

// Any other byte breaks the streak, so typing mid-hold does not carry word
// delete into the next backspace.
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', 1000 + i * 100));
  }
  const typed = applyBackspaceStreak(s, 'a', 2600);
  eq(typed.bytes, 'a', 'typing passes through');
  const after = applyBackspaceStreak(typed.streak, '\x7f', 2700);
  eq(after.bytes, '\x7f', 'typing reset the streak');
}

console.log(`\n  ${pass} assertions passed\n`);
