// Run: bun run src/server/pty.dims.test.ts
// Pure-function test only — does not spawn a PTY.
import { clampDims } from './pty';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

eq(clampDims(80, 24), { cols: 80, rows: 24 }, 'passthrough');
eq(clampDims('120', '40'), { cols: 120, rows: 40 }, 'numeric strings');
eq(clampDims(Number.NaN, undefined), { cols: 80, rows: 24 }, 'NaN/undefined -> defaults');
eq(clampDims(-5, 0), { cols: 2, rows: 2 }, 'floor at 2');
eq(clampDims(99999, 99999), { cols: 500, rows: 200 }, 'ceiling');
eq(clampDims(80.9, 24.9), { cols: 80, rows: 24 }, 'floats floored');

console.log(`\n  ${pass} assertions passed\n`);
