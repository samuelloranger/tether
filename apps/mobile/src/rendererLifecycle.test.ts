import { MAX_AUTO_REMOUNTS, RendererLifecycle, type RendererStatus } from './rendererLifecycle';

// One timer at a time, fired on demand — the lifecycle's whole job is what
// happens when a deadline expires, so real timers would only add flake.
function harness() {
  const queued = new Map<number, () => void>();
  let nextId = 1;
  const events: string[] = [];
  const statuses: RendererStatus[] = [];

  const lifecycle = new RendererLifecycle(
    {
      probe: () => events.push('probe'),
      remount: () => events.push('remount'),
      onStatus: (status) => statuses.push(status),
    },
    {
      schedule: (fn) => {
        const id = nextId++;
        queued.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (id) => {
        queued.delete(id as unknown as number);
      },
    },
  );

  return {
    lifecycle,
    events,
    statuses,
    expire: () => {
      for (const [id, fn] of Array.from(queued)) {
        queued.delete(id);
        fn();
      }
    },
    get pending() {
      return queued.size;
    },
  };
}

test('a page that boots becomes ready and arms nothing', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  expect(h.pending).toBe(1); // the readiness deadline
  h.lifecycle.pageReady();
  expect(h.lifecycle.current).toBe('ready');
  expect(h.pending).toBe(0);
  expect(h.events).toEqual([]);
});

// The hole the foreground-only watchdog left: a renderer that never posts
// `ready` at mount was never recovered, and the terminal stayed blank forever.
test('a page that never posts ready is remounted', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.expire();
  expect(h.events).toEqual(['remount']);
  expect(h.lifecycle.current).toBe('loading');
});

test('foregrounding probes a ready page and accepts any reply', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady();
  h.lifecycle.foregrounded();
  expect(h.events).toEqual(['probe']);
  h.lifecycle.sawMessage();
  h.expire();
  expect(h.events).toEqual(['probe']); // no remount: it answered
});

test('a probe that goes unanswered remounts', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady();
  h.lifecycle.foregrounded();
  h.expire();
  expect(h.events).toEqual(['probe', 'remount']);
});

test('foregrounding a page that is still loading does not probe', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.lifecycle.foregrounded();
  expect(h.events).toEqual([]);
});

test('repeated foregrounding while a probe is outstanding probes once', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady();
  h.lifecycle.foregrounded();
  h.lifecycle.foregrounded();
  h.lifecycle.foregrounded();
  expect(h.events).toEqual(['probe']);
});

test('a crash remounts immediately without waiting for a deadline', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady();
  h.lifecycle.crashed();
  expect(h.events).toEqual(['remount']);
});

// An endless remount loop burns battery and still shows a blank rectangle, so
// after a few attempts the failure becomes the user's to see.
test('it gives up after MAX_AUTO_REMOUNTS and reports stalled', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  for (let i = 0; i < MAX_AUTO_REMOUNTS; i++) {
    h.expire(); // readiness deadline for this attempt
    h.lifecycle.loadStarted(); // the remounted WebView starts loading
  }
  h.expire();
  expect(h.lifecycle.current).toBe('stalled');
  expect(h.events.filter((e) => e === 'remount')).toHaveLength(MAX_AUTO_REMOUNTS);
  expect(h.statuses.at(-1)).toBe('stalled');
});

test('a successful boot resets the attempt budget', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  h.expire(); // one failed attempt
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady(); // recovered
  h.lifecycle.crashed();
  h.lifecycle.loadStarted();
  h.lifecycle.pageReady();
  expect(h.lifecycle.current).toBe('ready');
});

test('retry from the stalled UI starts over', () => {
  const h = harness();
  h.lifecycle.loadStarted();
  for (let i = 0; i < MAX_AUTO_REMOUNTS; i++) {
    h.expire();
    h.lifecycle.loadStarted();
  }
  h.expire();
  expect(h.lifecycle.current).toBe('stalled');
  h.lifecycle.retry();
  expect(h.lifecycle.current).toBe('loading');
  expect(h.events.filter((e) => e === 'remount')).toHaveLength(MAX_AUTO_REMOUNTS + 1);
});
