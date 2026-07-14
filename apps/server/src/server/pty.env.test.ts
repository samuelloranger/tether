// Run: bun run src/server/pty.env.test.ts
// Pure-function test only — does not spawn a PTY.
import { withTermEnv } from './pty';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

eq(
  withTermEnv({}).TERM,
  'xterm-256color',
  'sets TERM when absent, so remote programs see 256-color support',
);
eq(withTermEnv({}).COLORTERM, 'truecolor', 'sets COLORTERM when absent');
eq(
  withTermEnv({ TERM: 'dumb' }).TERM,
  'xterm-256color',
  'overrides a pre-existing TERM (e.g. inherited "dumb") rather than deferring to it',
);
eq(withTermEnv({ FOO: 'bar' }).FOO, 'bar', 'preserves unrelated existing env vars');

console.log(`\n  ${pass} assertions passed\n`);
