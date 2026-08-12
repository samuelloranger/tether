import { describe, expect, test } from 'bun:test';
import {
  needsRegistration,
  normalizeDeviceToken,
  type PushRegistrationTarget,
  registerWithHosts,
} from './pushRegistration';

const HEX = 'a1b2'.repeat(16);

describe('normalizeDeviceToken', () => {
  test('passes through bare hex', () => {
    expect(normalizeDeviceToken(HEX)).toBe(HEX);
  });

  test('lowercases so the server regex and stored value agree', () => {
    expect(normalizeDeviceToken(HEX.toUpperCase())).toBe(HEX);
  });

  test('strips the bracketed NSData description iOS sometimes yields', () => {
    const spaced = `<${HEX.slice(0, 32)} ${HEX.slice(32)}>`;
    expect(normalizeDeviceToken(spaced)).toBe(HEX);
  });

  test.each([
    ['too short', 'a1b2'],
    ['empty', ''],
    ['an Expo push token', 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeDeviceToken(raw)).toBeNull();
  });
});

describe('needsRegistration', () => {
  const current = { deviceToken: HEX, secretKey: 'key' };

  test('registers when nothing was stored', () => {
    expect(needsRegistration(null, current)).toBe(true);
  });

  test('skips when nothing changed, so cold starts do not spam every host', () => {
    expect(needsRegistration({ ...current }, current)).toBe(false);
  });

  test('re-registers when APNs rotates the token', () => {
    expect(needsRegistration({ deviceToken: 'b'.repeat(64), secretKey: 'key' }, current)).toBe(
      true,
    );
  });

  test('re-registers when the secret key is regenerated', () => {
    expect(needsRegistration({ deviceToken: HEX, secretKey: 'old' }, current)).toBe(true);
  });
});

describe('registerWithHosts', () => {
  const target = (hostId: string, impl: PushRegistrationTarget['post']) => ({ hostId, post: impl });
  const ok = async () => ({ ok: true, status: 200 });

  test('posts the payload to every host', async () => {
    const seen: string[] = [];
    const results = await registerWithHosts(
      [
        target('a', async (path, init) => {
          seen.push(`a:${path}:${init?.body}`);
          return { ok: true, status: 200 };
        }),
        target('b', ok),
      ],
      { deviceToken: HEX, secretKey: 'k' },
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen[0]).toBe(`a:/api/push/register:{"deviceToken":"${HEX}","secretKey":"k"}`);
  });

  test('one unreachable host does not prevent the others registering', async () => {
    const results = await registerWithHosts(
      [
        target('down', async () => {
          throw new Error('Network request failed');
        }),
        target('up', ok),
      ],
      { deviceToken: HEX, secretKey: 'k' },
    );
    expect(results).toEqual([
      { hostId: 'down', ok: false, error: 'Network request failed' },
      { hostId: 'up', ok: true, status: 200 },
    ]);
  });

  test('reports a rejecting host without throwing', async () => {
    const results = await registerWithHosts(
      [target('old', async () => ({ ok: false, status: 404 }))],
      { deviceToken: HEX, secretKey: 'k' },
    );
    // A server too old to know the route is a normal outcome, not an error.
    expect(results[0]).toEqual({ hostId: 'old', ok: false, status: 404 });
  });
});
