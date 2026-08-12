import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { ApnsTokenCache, signApnsJwt } from './apnsAuth';

// A real ES256 key, generated per run — never a fixture, so no private key
// material is ever committed to the repo.
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const KEY = { keyId: 'ABC123DEFG', teamId: 'SSU33B2E5B', privateKeyPem: privateKey as string };

const decode = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString());

describe('signApnsJwt', () => {
  test('produces the header and claims APNs requires', () => {
    const [header, claims, signature] = signApnsJwt(KEY, 1_700_000_000).split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(decode(claims)).toEqual({ iss: 'SSU33B2E5B', iat: 1_700_000_000 });
    // ES256 is a fixed 64-byte r||s signature; a DER-encoded one would be
    // variable-length and APNs rejects it.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
  });

  test('is base64url with no padding, so it is header-safe', () => {
    expect(signApnsJwt(KEY, 1)).not.toContain('=');
    expect(signApnsJwt(KEY, 1)).not.toMatch(/[+/]/);
  });
});

describe('ApnsTokenCache', () => {
  test('reuses one token rather than signing per push', () => {
    let now = 1_000_000;
    const cache = new ApnsTokenCache(KEY, () => now);
    const first = cache.get();
    now += 60;
    expect(cache.get()).toBe(first);
  });

  test('re-signs once the token approaches the APNs 1-hour limit', () => {
    let now = 1_000_000;
    const cache = new ApnsTokenCache(KEY, () => now);
    const first = cache.get();
    now += 50 * 60;
    const second = cache.get();
    expect(second).not.toBe(first);
    // Still comfortably inside Apple's 60-minute ceiling.
    expect(decode(second.split('.')[1]).iat).toBe(1_000_000 + 50 * 60);
  });
});
