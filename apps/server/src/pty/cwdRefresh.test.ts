import { expect, test } from 'bun:test';
import {
  CWD_REFRESH_COOLDOWN_MS,
  CwdRefreshGate,
  cooldownUntilAfterTimeout,
  planCwdRefresh,
} from './cwdRefresh';

const binaryLink = {
  hasLink: true,
  exited: false,
  dialect: 'binary' as const,
};

test('planCwdRefresh skips when there is no link or the holder has exited', () => {
  expect(
    planCwdRefresh({
      hasLink: false,
      exited: false,
      dialect: 'binary',
      cooldownUntil: null,
      waiterCount: 0,
      now: 0,
    }),
  ).toBe('skip');
  expect(
    planCwdRefresh({
      ...binaryLink,
      exited: true,
      cooldownUntil: null,
      waiterCount: 0,
      now: 0,
    }),
  ).toBe('skip');
});

test('planCwdRefresh skips a negotiated legacy holder without waiting', () => {
  // Legacy is rejected here — not by a permanent latch after a timeout — so a
  // pre-v2 holder never pays the 250ms CWDREQ wait on every git/file call.
  expect(
    planCwdRefresh({
      hasLink: true,
      exited: false,
      dialect: 'legacy',
      cooldownUntil: null,
      waiterCount: 0,
      now: 0,
    }),
  ).toBe('skip');
});

test('an unanswered request arms a cooldown; calls during it skip without waiting', async () => {
  const gate = new CwdRefreshGate();
  expect(gate.plan({ ...binaryLink, now: 1_000 })).toBe('start');

  const first = gate.wait();
  gate.onTimeout(1_000);
  expect(await first).toBe(false);
  expect(gate.waiterCount).toBe(0);
  expect(gate.cooldownUntil).toBe(1_000 + CWD_REFRESH_COOLDOWN_MS);

  expect(gate.plan({ ...binaryLink, now: 1_000 + 1 })).toBe('skip');
  expect(gate.plan({ ...binaryLink, now: 1_000 + CWD_REFRESH_COOLDOWN_MS - 1 })).toBe('skip');
});
test('after the cooldown elapses, the next call tries again', () => {
  const gate = new CwdRefreshGate();
  gate.wait();
  gate.onTimeout(0);
  expect(gate.plan({ ...binaryLink, now: CWD_REFRESH_COOLDOWN_MS })).toBe('start');
  expect(gate.plan({ ...binaryLink, now: CWD_REFRESH_COOLDOWN_MS + 1 })).toBe('start');
});

test('concurrent callers join one wait — one settle wakes all, waiters do not accumulate', async () => {
  const gate = new CwdRefreshGate();
  expect(gate.plan({ ...binaryLink, now: 0 })).toBe('start');

  const a = gate.wait();
  expect(gate.plan({ ...binaryLink, now: 0 })).toBe('join');
  const b = gate.wait();
  expect(gate.waiterCount).toBe(2);

  // One timeout settles every waiter; no second full wait is stacked.
  gate.onTimeout(0);
  expect(await Promise.all([a, b])).toEqual([false, false]);
  expect(gate.waiterCount).toBe(0);
});

test('a successful answer clears the cooldown so a recovered holder stays warm', async () => {
  const gate = new CwdRefreshGate();
  gate.wait();
  gate.onTimeout(0);
  expect(gate.cooldownUntil).not.toBeNull();

  expect(gate.plan({ ...binaryLink, now: CWD_REFRESH_COOLDOWN_MS })).toBe('start');
  const again = gate.wait();
  gate.onAnswer(true);
  expect(await again).toBe(true);
  expect(gate.cooldownUntil).toBeNull();
});

test('cooldownUntilAfterTimeout is now + the configured window', () => {
  expect(cooldownUntilAfterTimeout(10_000)).toBe(10_000 + CWD_REFRESH_COOLDOWN_MS);
  expect(cooldownUntilAfterTimeout(10_000, 3_000)).toBe(13_000);
});
