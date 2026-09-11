import { describe, expect, test } from 'bun:test';
import { looksLikeToken, mintToken, verifyToken } from './deviceToken';

const known = (id: string) => (candidate: string) => candidate === id;

describe('deviceToken', () => {
  test('mint then verify returns the deviceId', () => {
    const token = mintToken('dev-1');
    expect(verifyToken(token, { deviceExists: known('dev-1') })).toEqual({ deviceId: 'dev-1' });
  });

  test('tampered payload returns null', () => {
    const token = mintToken('dev-1');
    const [payload, sig] = token.split('.');
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      v: number;
      sub: string;
      iat: number;
      exp: number;
    };
    json.sub = 'other';
    const tampered = `${Buffer.from(JSON.stringify(json)).toString('base64url')}.${sig}`;
    expect(verifyToken(tampered, { deviceExists: () => true })).toBeNull();
  });

  test('tampered signature returns null', () => {
    const token = mintToken('dev-1');
    const [payload, sig] = token.split('.');
    const sigBytes = Buffer.from(sig, 'base64url');
    sigBytes[0] ^= 0xff;
    const tampered = `${payload}.${sigBytes.toString('base64url')}`;
    expect(verifyToken(tampered, { deviceExists: known('dev-1') })).toBeNull();
  });

  test('expired token returns null when now is past exp', () => {
    const token = mintToken('dev-1', 10);
    const now = Math.floor(Date.now() / 1000) + 11;
    expect(verifyToken(token, { now, deviceExists: known('dev-1') })).toBeNull();
  });

  test('unknown device returns null', () => {
    const token = mintToken('dev-1');
    expect(verifyToken(token, { deviceExists: () => false })).toBeNull();
  });

  test('looksLikeToken is true for a minted token and false for a password', () => {
    const token = mintToken('dev-1');
    expect(looksLikeToken(token)).toBe(true);
    expect(looksLikeToken('hunter2')).toBe(false);
  });
});
