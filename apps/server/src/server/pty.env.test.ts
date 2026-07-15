// Run: bun run src/server/pty.env.test.ts
// Pure-function test only — does not spawn a PTY.
import { sessionEnv, withTermEnv } from './pty';

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

eq(
  sessionEnv('term-1', {}, undefined).TETHER_SESSION_ID,
  'term-1',
  'stamps the session id so the agent/CLI running inside this shell can read it',
);
eq(
  sessionEnv('term-1', {}, { ZDOTDIR: '/x' }).ZDOTDIR,
  '/x',
  'still merges shell-specific env (e.g. zsh ZDOTDIR)',
);
eq(
  sessionEnv('term-1', { FOO: 'bar' }, undefined).FOO,
  'bar',
  'still preserves unrelated existing env vars via withTermEnv/scrubAgentEnv',
);
eq(
  sessionEnv('term-1', {}, undefined).TERM,
  'xterm-256color',
  'still applies withTermEnv (TERM/COLORTERM overrides)',
);

console.log(`\n  ${pass} assertions passed\n`);
