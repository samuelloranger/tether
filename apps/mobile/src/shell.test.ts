// Run: bun run src/shell.test.ts (from apps/mobile)
import { shellQuote } from './shell';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

eq(shellQuote('/tmp/My Photo.jpg'), "'/tmp/My Photo.jpg'", 'spaces are quoted');
eq(shellQuote("/tmp/O'Reilly.txt"), "'/tmp/O'\"'\"'Reilly.txt'", 'single quotes are escaped');
eq(shellQuote('/tmp/$(touch nope).txt'), "'/tmp/$(touch nope).txt'", 'shell syntax is literal');

console.log(`\n  ${pass} assertions passed\n`);
