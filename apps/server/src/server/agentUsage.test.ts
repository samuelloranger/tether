import { beforeEach, describe, expect, test } from 'bun:test';
import { fetchAgentUsage, parseUsageLimits, resetUsageCache } from './agentUsage';

// Shape captured live from GET /api/oauth/usage (redacted).
const LIVE = {
  five_hour: { utilization: 53, resets_at: '2026-09-08T21:00:00Z', limit_dollars: null },
  seven_day: { utilization: 35, resets_at: '2026-09-14T00:00:00Z', limit_dollars: null },
  seven_day_opus: null,
  limits: [{ kind: 'session', percent: 53 }],
};

describe('parseUsageLimits', () => {
  test('extracts both windows from the live shape', () => {
    expect(parseUsageLimits(LIVE)).toEqual({
      fiveHour: { utilization: 53, resetsAt: '2026-09-08T21:00:00Z' },
      sevenDay: { utilization: 35, resetsAt: '2026-09-14T00:00:00Z' },
    });
  });

  test('resets_at may be missing', () => {
    expect(parseUsageLimits({ five_hour: { utilization: 10 } })).toEqual({
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: null,
    });
  });

  test('null when neither window present or body is junk', () => {
    expect(parseUsageLimits({ seven_day_opus: null })).toBeNull();
    expect(parseUsageLimits(null)).toBeNull();
    expect(parseUsageLimits('nope')).toBeNull();
  });
});

describe('fetchAgentUsage', () => {
  beforeEach(() => resetUsageCache());

  const okFetch = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  test('returns parsed limits on 200', async () => {
    const val = await fetchAgentUsage({
      readToken: () => 'tok',
      fetchImpl: okFetch(LIVE),
      now: 1000,
    });
    expect(val?.fiveHour?.utilization).toBe(53);
    expect(val?.sevenDay?.utilization).toBe(35);
  });

  test('null when no token, without calling fetch', async () => {
    let called = false;
    const val = await fetchAgentUsage({
      readToken: () => null,
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
      now: 2000,
    });
    expect(val).toBeNull();
    expect(called).toBe(false);
  });

  test('null on non-2xx', async () => {
    const val = await fetchAgentUsage({
      readToken: () => 'tok',
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
      now: 3000,
    });
    expect(val).toBeNull();
  });

  test('null on network throw', async () => {
    const val = await fetchAgentUsage({
      readToken: () => 'tok',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      now: 4000,
    });
    expect(val).toBeNull();
  });

  test('serves cache within TTL, skips a second fetch', async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(LIVE), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAgentUsage({ readToken: () => 'tok', fetchImpl: counting, now: 10_000 });
    await fetchAgentUsage({ readToken: () => 'tok', fetchImpl: counting, now: 10_500 });
    expect(calls).toBe(1);
    // Past the TTL it fetches again.
    await fetchAgentUsage({ readToken: () => 'tok', fetchImpl: counting, now: 80_000 });
    expect(calls).toBe(2);
  });
});
