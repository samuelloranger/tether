import { expect, mock, test } from 'bun:test';
import type { Terminal } from '@xterm/xterm';

// One addon instance per construction, recorded so a test can trigger context
// loss and count disposals. `behavior` lets a test make the constructor throw.
const state = {
  behavior: 'ok' as 'ok' | 'throw',
  instances: [] as Array<{ disposed: number; loseContext: () => void }>,
};

mock.module('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    disposed = 0;
    private onLoss: (() => void) | null = null;
    constructor() {
      if (state.behavior === 'throw') throw new Error('no webgl context');
      state.instances.push(this as unknown as (typeof state.instances)[number]);
    }
    onContextLoss(handler: () => void) {
      this.onLoss = handler;
    }
    loseContext() {
      this.onLoss?.();
    }
    dispose() {
      this.disposed++;
    }
  },
}));

const { attachWebgl } = await import('./terminalWebgl');

function harness() {
  state.behavior = 'ok';
  state.instances = [];
  const fallbacks: string[] = [];
  const refreshes: Array<[number, number]> = [];
  const terminal = {
    rows: 24,
    loadAddon: () => {},
    refresh: (start: number, end: number) => {
      refreshes.push([start, end]);
    },
  } as unknown as Terminal;
  // Mutable holder, mirroring the ref TerminalView swaps on every render.
  const callbacks = { current: { onFallback: (reason: string) => fallbacks.push(reason) } };
  return { terminal, callbacks, fallbacks, refreshes };
}

test('reports a fallback when the addon cannot be constructed', () => {
  const h = harness();
  state.behavior = 'throw';
  const handle = attachWebgl(h.terminal, h.callbacks);
  expect(h.fallbacks).toEqual(['Error: no webgl context']);
  // Nothing to dispose, and disposing must not throw.
  handle.dispose();
});

// Regression: attachWebgl used to receive `callbacks.current` directly, pinning
// onFallback to the object present at mount. Every other consumer in
// mountDesktopTerminal reads .current at call time; this one must too.
test('calls the current onFallback, not the one present at attach time', () => {
  const h = harness();
  attachWebgl(h.terminal, h.callbacks);
  const later: string[] = [];
  h.callbacks.current = { onFallback: (reason: string) => later.push(reason) };
  state.instances[0]?.loseContext();
  expect(h.fallbacks).toEqual([]);
  expect(later).toEqual(['webgl-context-lost']);
  expect(h.refreshes).toEqual([[0, 23]]);
});

// Regression: the extracted helper dropped `webgl = null` after the context-loss
// dispose, so the unmount cleanup disposed the same addon a second time.
test('does not dispose twice when cleanup follows a context loss', () => {
  const h = harness();
  const handle = attachWebgl(h.terminal, h.callbacks);
  const addon = state.instances[0];
  addon?.loseContext();
  expect(addon?.disposed).toBe(1);
  handle.dispose();
  expect(addon?.disposed).toBe(1);
});

test('disposes once on a clean unmount', () => {
  const h = harness();
  const handle = attachWebgl(h.terminal, h.callbacks);
  handle.dispose();
  expect(state.instances[0]?.disposed).toBe(1);
});
