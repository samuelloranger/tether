import { describe, expect, test } from 'bun:test';
import {
  decryptPushContent,
  encryptPushContent,
  generateSecretKeyBase64,
  isValidSecretKey,
} from './pushCrypto';

const CONTENT = { title: 'alpha · vim README.md', body: 'Waiting for input', link: 'tether://x' };

describe('push key handling', () => {
  test('generated keys are 32 bytes and accepted', () => {
    const key = generateSecretKeyBase64();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(isValidSecretKey(key)).toBe(true);
  });

  test.each([
    ['a short key', Buffer.alloc(16).toString('base64')],
    ['a long key', Buffer.alloc(64).toString('base64')],
    ['not base64 at all', '!!!!'],
  ])('rejects %s', (_label, key) => {
    expect(isValidSecretKey(key)).toBe(false);
  });
});

describe('encryptPushContent', () => {
  test('round-trips through decrypt', async () => {
    const key = generateSecretKeyBase64();
    const sealed = await encryptPushContent(key, CONTENT);
    expect(await decryptPushContent(key, sealed)).toEqual(CONTENT);
  });

  test('leaks no plaintext into the ciphertext', async () => {
    // The entire point of the relay design: session titles must not be
    // recoverable from what crosses the wire.
    const sealed = await encryptPushContent(generateSecretKeyBase64(), CONTENT);
    const decoded = Buffer.from(sealed, 'base64').toString('binary');
    expect(decoded).not.toContain('alpha');
    expect(decoded).not.toContain('README');
    expect(decoded).not.toContain('Waiting');
  });

  test('uses a fresh nonce per message, so identical content differs on the wire', async () => {
    const key = generateSecretKeyBase64();
    const a = await encryptPushContent(key, CONTENT);
    const b = await encryptPushContent(key, CONTENT);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').subarray(0, 12)).not.toEqual(
      Buffer.from(b, 'base64').subarray(0, 12),
    );
  });

  test('a wrong key cannot decrypt', async () => {
    const sealed = await encryptPushContent(generateSecretKeyBase64(), CONTENT);
    expect(decryptPushContent(generateSecretKeyBase64(), sealed)).rejects.toThrow();
  });

  test('tampering with the ciphertext is detected rather than silently accepted', async () => {
    // GCM is authenticated; a flipped byte must fail the tag check.
    const key = generateSecretKeyBase64();
    const raw = Buffer.from(await encryptPushContent(key, CONTENT), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(decryptPushContent(key, raw.toString('base64'))).rejects.toThrow();
  });

  test('refuses a key of the wrong length instead of encrypting weakly', () => {
    expect(encryptPushContent(Buffer.alloc(16).toString('base64'), CONTENT)).rejects.toThrow(
      'push secret key must be 32 bytes',
    );
  });
});
