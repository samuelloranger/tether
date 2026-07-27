import { RendererWatchdog } from './rendererWatchdog';

// Deterministic timer stand-in: the watchdog only ever holds one timer.
function fakeTimers() {
  const queued = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (fn: () => void) => {
      const id = next++;
      queued.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id: unknown) => {
      queued.delete(id as number);
    },
    fire: () => {
      for (const [id, fn] of Array.from(queued)) {
        queued.delete(id);
        fn();
      }
    },
    get size() {
      return queued.size;
    },
  };
}

function build() {
  const timers = fakeTimers();
  let probes = 0;
  let stalls = 0;
  const watchdog = new RendererWatchdog(
    () => probes++,
    () => stalls++,
    2500,
    timers.schedule,
    timers.cancel,
  );
  return { watchdog, timers, probes: () => probes, stalls: () => stalls };
}

test('a renderer that answers the probe is left alone', () => {
  const { watchdog, timers, probes, stalls } = build();
  watchdog.check();
  expect(probes()).toBe(1);
  watchdog.alive();
  timers.fire();
  expect(stalls()).toBe(0);
  expect(watchdog.pending).toBe(false);
});

test('a renderer that never answers is reported as stalled', () => {
  const { watchdog, timers, stalls } = build();
  watchdog.check();
  timers.fire();
  expect(stalls()).toBe(1);
  expect(watchdog.pending).toBe(false);
});

// Foregrounding repeatedly (or a crash callback landing during a probe) must not
// stack timers, or one dead renderer would fire several remounts.
test('overlapping checks probe once', () => {
  const { watchdog, timers, probes, stalls } = build();
  watchdog.check();
  watchdog.check();
  watchdog.check();
  expect(probes()).toBe(1);
  expect(timers.size).toBe(1);
  timers.fire();
  expect(stalls()).toBe(1);
});

test('a later check re-arms after the previous one resolved', () => {
  const { watchdog, timers, probes } = build();
  watchdog.check();
  watchdog.alive();
  watchdog.check();
  expect(probes()).toBe(2);
  expect(timers.size).toBe(1);
});

test('stop cancels an outstanding probe', () => {
  const { watchdog, timers, stalls } = build();
  watchdog.check();
  watchdog.stop();
  timers.fire();
  expect(stalls()).toBe(0);
});
