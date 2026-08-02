import { expect, test } from 'bun:test';
import { clampDims, type Dims, planPtyResize } from './ptyResize';

test('clampDims passes sane values through', () => {
  expect(clampDims(80, 24)).toEqual({ cols: 80, rows: 24 });
  expect(clampDims('120', '40')).toEqual({ cols: 120, rows: 40 });
});

test('clampDims defaults, floors, ceilings and truncates', () => {
  expect(clampDims(Number.NaN, undefined)).toEqual({ cols: 80, rows: 24 });
  expect(clampDims(-5, 0)).toEqual({ cols: 2, rows: 2 });
  expect(clampDims(99999, 99999)).toEqual({ cols: 500, rows: 200 });
  expect(clampDims(80.9, 24.9)).toEqual({ cols: 80, rows: 24 });
});

test('no attached clients means no resize', () => {
  expect(planPtyResize(null, [])).toBeNull();
  expect(planPtyResize({ cols: 80, rows: 24 }, [])).toBeNull();
});

test('fits the PTY to the smallest attached client on each axis', () => {
  const clients: Dims[] = [
    { cols: 120, rows: 30 },
    { cols: 90, rows: 60 },
  ];
  expect(planPtyResize(null, clients)).toEqual({ cols: 90, rows: 30 });
});

test('clamps the fitted result', () => {
  expect(planPtyResize(null, [{ cols: 0, rows: 9999 }])).toEqual({ cols: 2, rows: 200 });
});

// The regression this module exists for. Returning from another app reconnects
// every resident session; each reconnect detaches then reattaches, recomputing
// the size twice at the SAME dims. Each frame reached proc.terminal.resize(),
// which raises SIGWINCH unconditionally, and Claude Code / cursor-agent answer
// every SIGWINCH with a full repaint — so an app switch cost two full-screen
// repaints per tab, interleaved with the reconnect replay.
test('a recompute that lands on the current size sends nothing', () => {
  const dims = { cols: 90, rows: 30 };
  expect(planPtyResize(dims, [{ cols: 90, rows: 30 }])).toBeNull();
});

test('reconnect churn at steady dims is silent, a real change is not', () => {
  const alice = { cols: 90, rows: 30 };
  const bob = { cols: 120, rows: 45 };
  let pty: Dims | null = null;

  // Both clients attach — only the first fit actually changes the PTY.
  pty = planPtyResize(pty, [alice, bob]) ?? pty;
  expect(pty).toEqual({ cols: 90, rows: 30 });
  expect(planPtyResize(pty, [alice, bob])).toBeNull();

  // Bob's socket drops and comes back (the app-switch path). Bob is the larger
  // client, so the fit never moves and no SIGWINCH should be raised.
  expect(planPtyResize(pty, [alice])).toBeNull();
  expect(planPtyResize(pty, [alice, bob])).toBeNull();

  // Alice actually rotates: that must still resize.
  const rotated = { cols: 60, rows: 80 };
  expect(planPtyResize(pty, [rotated, bob])).toEqual({ cols: 60, rows: 45 });
});

test('the smallest client leaving grows the PTY back', () => {
  const pty = { cols: 90, rows: 30 };
  expect(planPtyResize(pty, [{ cols: 120, rows: 45 }])).toEqual({ cols: 120, rows: 45 });
});
