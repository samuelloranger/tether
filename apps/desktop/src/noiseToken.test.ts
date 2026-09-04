import { describe, expect, it } from 'bun:test';
import { createTokenCache } from './noiseToken';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('createTokenCache', () => {
  it('mints on the first getToken and returns that token', async () => {
    let calls = 0;
    const cache = createTokenCache({
      mint: async (hostId, address) => {
        calls += 1;
        expect(hostId).toBe('host-1');
        expect(address).toBe('ws://example:8085/api/noise/session');
        return { token: 'tok-1', expiresAt: iso(1_000_000 + 86_400_000) };
      },
      now: () => 1_000_000,
    });

    await expect(cache.getToken('host-1', 'ws://example:8085/api/noise/session')).resolves.toBe(
      'tok-1',
    );
    expect(calls).toBe(1);
  });

  it('reuses a cached token until 90% of its lifetime', async () => {
    let calls = 0;
    let nowMs = 1_000_000;
    const lifetime = 10_000;
    const cache = createTokenCache({
      mint: async () => {
        calls += 1;
        return { token: `tok-${calls}`, expiresAt: iso(1_000_000 + lifetime) };
      },
      now: () => nowMs,
    });

    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-1');
    nowMs = 1_000_000 + lifetime * 0.9 - 1;
    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-1');
    expect(calls).toBe(1);
  });

  it('remints once the token is at 90% of its lifetime', async () => {
    let calls = 0;
    let nowMs = 1_000_000;
    const lifetime = 10_000;
    const cache = createTokenCache({
      mint: async () => {
        calls += 1;
        return { token: `tok-${calls}`, expiresAt: iso(nowMs + lifetime) };
      },
      now: () => nowMs,
    });

    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-1');
    nowMs = 1_000_000 + lifetime * 0.9;
    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-2');
    expect(calls).toBe(2);
  });

  it('remints after invalidate, the 401-refresh path', async () => {
    let calls = 0;
    const cache = createTokenCache({
      mint: async () => {
        calls += 1;
        return { token: `tok-${calls}`, expiresAt: iso(1_000_000 + 86_400_000) };
      },
      now: () => 1_000_000,
    });

    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-1');
    cache.invalidate('h');
    await expect(cache.getToken('h', 'ws://x')).resolves.toBe('tok-2');
    expect(calls).toBe(2);
  });

  it('caches tokens per hostId', async () => {
    const minted: string[] = [];
    const cache = createTokenCache({
      mint: async (hostId) => {
        minted.push(hostId);
        return { token: `tok-${hostId}`, expiresAt: iso(1_000_000 + 86_400_000) };
      },
      now: () => 1_000_000,
    });

    await expect(cache.getToken('a', 'ws://a')).resolves.toBe('tok-a');
    await expect(cache.getToken('b', 'ws://b')).resolves.toBe('tok-b');
    await expect(cache.getToken('a', 'ws://a')).resolves.toBe('tok-a');
    expect(minted).toEqual(['a', 'b']);
  });
});
