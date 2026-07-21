import { expect, test } from 'bun:test';
import { digestForAsset, verifyDigest } from './update';

test('verifyDigest accepts a matching sha256', () => {
  const bytes = new TextEncoder().encode('hello');
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  expect(verifyDigest(bytes, digest)).toBe(true);
});

test('verifyDigest is case-insensitive and trims', () => {
  const bytes = new TextEncoder().encode('hello');
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex').toUpperCase();
  expect(verifyDigest(bytes, `  ${digest}\n`)).toBe(true);
});

test('verifyDigest rejects a mismatch', () => {
  const bytes = new TextEncoder().encode('hello');
  expect(verifyDigest(bytes, 'deadbeef')).toBe(false);
});

test('digestForAsset parses a sha256sum manifest', () => {
  const manifest = [
    'aaaa1111  tether-linux-x64-v1.0.0',
    'bbbb2222 *tether-darwin-arm64-v1.0.0.tar.gz',
  ].join('\n');
  expect(digestForAsset(manifest, 'tether-linux-x64-v1.0.0')).toBe('aaaa1111');
  expect(digestForAsset(manifest, 'tether-darwin-arm64-v1.0.0.tar.gz')).toBe('bbbb2222');
  expect(digestForAsset(manifest, 'nope')).toBeNull();
});
