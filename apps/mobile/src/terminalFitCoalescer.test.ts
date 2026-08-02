import { expect, test } from 'bun:test';
import { FitCoalescer } from './terminalFitCoalescer';

// A hand-driven clock: the coalescer's whole job is timing, and a real timer
// would make these tests slow and flaky.
function fakeClock() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = next++;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer: ReturnType<typeof setTimeout>) => {
      pending.delete(timer as unknown as number);
    },
    /** Fire every timer that is still armed. */
    tick: () => {
      const due = Array.from(pending.values());
      pending.clear();
      for (const fn of due) fn();
    },
    get armed() {
      return pending.size;
    },
  };
}

function build() {
  const clock = fakeClock();
  let fits = 0;
  const coalescer = new FitCoalescer(() => fits++, {
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, coalescer, fits: () => fits };
}

test('a single request fits once, on the trailing edge', () => {
  const { clock, coalescer, fits } = build();
  coalescer.request();
  expect(fits()).toBe(0); // trailing edge: nothing yet
  expect(coalescer.pending).toBe(true);
  clock.tick();
  expect(fits()).toBe(1);
  expect(coalescer.pending).toBe(false);
});

// The regression. iOS slides the soft keyboard in over ~250ms and
// ResizeObserver fires throughout. Every one of those ticks used to resize the
// local grid while the PTY lagged behind, so the agent's differential repaint
// patched rows that had already moved.
test('a burst of ticks during the keyboard animation collapses to one fit', () => {
  const { clock, coalescer, fits } = build();
  for (let i = 0; i < 12; i++) coalescer.request();
  expect(clock.armed).toBe(1); // each request replaced the last
  clock.tick();
  expect(fits()).toBe(1);
});

test('a later burst fits again — coalescing is not one-shot', () => {
  const { clock, coalescer, fits } = build();
  coalescer.request();
  clock.tick();
  coalescer.request();
  coalescer.request();
  clock.tick();
  expect(fits()).toBe(2);
});

test('flush runs an owed fit immediately and disarms it', () => {
  const { clock, coalescer, fits } = build();
  coalescer.request();
  coalescer.flush();
  expect(fits()).toBe(1);
  expect(coalescer.pending).toBe(false);
  clock.tick(); // the owed timer must not fire a second fit
  expect(fits()).toBe(1);
});

test('flush with nothing owed still fits — mount and hydrate rely on it', () => {
  const { coalescer, fits } = build();
  coalescer.flush();
  expect(fits()).toBe(1);
});

test('dispose drops an owed fit without running it', () => {
  const { clock, coalescer, fits } = build();
  coalescer.request();
  coalescer.dispose();
  clock.tick();
  expect(fits()).toBe(0);
});
