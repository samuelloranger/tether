import { expect, test } from 'bun:test';
import { createHostPolling, pollHostSessions, sessionPollInterval } from './hostPolling';
import type { HostProfile } from './hostStore';

const host = (id: string): HostProfile => ({
  id,
  name: id,
  color: '#89b4fa',
  host: `${id}.local`,
  port: '8085',
  identityName: id,
  order: 0,
});

test('uses the active and background polling cadences', () => {
  expect(sessionPollInterval(true)).toBe(4_000);
  expect(sessionPollInterval(false)).toBe(15_000);
});

test('schedules each host independently using its current active/background cadence', async () => {
  const scheduled: number[] = [];
  const polling = createHostPolling({
    getProfiles: () => [host('background'), host('active')],
    getActiveHostId: () => 'active',
    getHealth: () => ({ status: 'unknown', failures: 0 }),
    clientFor: () => ({ get: async () => ({ ok: true, status: 200, json: async () => [] }) }),
    onSessions: () => {},
    onHealth: () => {},
    schedule: (_run, delay) => {
      scheduled.push(delay);
      return scheduled.length;
    },
    clearScheduled: () => {},
  });

  await polling.start();
  expect(scheduled).toEqual([15_000, 4_000]);
});

test('contains one host rejection while another host continues to receive sessions', async () => {
  const sessions: string[] = [];
  const health: string[] = [];
  await pollHostSessions({
    profiles: [host('offline'), host('online')],
    activeHostId: 'online',
    clientFor: (profile) => ({
      get: async () => {
        if (profile.id === 'offline') throw new Error('network down');
        return { ok: true, status: 200, json: async () => [{ id: 'term-1' }] };
      },
    }),
    onSessions: (profile, rows) => sessions.push(`${profile.id}:${rows[0]?.id}`),
    onHealth: (profile, result) => health.push(`${profile.id}:${result}`),
  });

  expect(sessions).toEqual(['online:term-1']);
  expect(health).toEqual(['offline:failure', 'online:success']);
});

test('reports 401 as unauthorized without attempting to parse sessions', async () => {
  const health: string[] = [];
  await pollHostSessions({
    profiles: [host('locked')],
    activeHostId: 'locked',
    clientFor: () => ({
      get: async () => ({
        ok: false,
        status: 401,
        json: async () => {
          throw new Error('unused');
        },
      }),
    }),
    onSessions: () => {
      throw new Error('must not receive sessions');
    },
    onHealth: (_profile, result) => health.push(result),
  });

  expect(health).toEqual(['unauthorized']);
});

test('backs off a dead host instead of scheduling its normal polling cadence', async () => {
  const scheduled: number[] = [];
  const polling = createHostPolling({
    getProfiles: () => [host('offline')],
    getActiveHostId: () => 'offline',
    getHealth: () => ({ status: 'unknown', failures: 0 }),
    clientFor: () => ({ get: async () => Promise.reject(new Error('offline')) }),
    onSessions: () => {},
    onHealth: () => {},
    schedule: (_run, delay) => {
      scheduled.push(delay);
      return scheduled.length;
    },
    clearScheduled: () => {},
  });

  await polling.start();
  expect(scheduled).toEqual([2_000]);
});
