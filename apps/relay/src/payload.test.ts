import { describe, expect, test } from 'bun:test';
import { APNS_MAX_PAYLOAD_BYTES, buildApnsPayload, classifyApnsStatus, pushRequestSchema } from './payload';

const TOKEN = 'a'.repeat(64);

describe('pushRequestSchema', () => {
  test('accepts a cleartext push', () => {
    const r = pushRequestSchema.safeParse({ token: TOKEN, title: 'Tether', body: 'Waiting' });
    expect(r.success).toBe(true);
  });

  test('accepts an encrypted push', () => {
    const r = pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'YmFzZTY0' });
    expect(r.success).toBe(true);
  });

  test('rejects a push carrying both cleartext and ciphertext', () => {
    // Guards the property the whole design rests on: if a caller sends readable
    // text alongside the encrypted copy, the relay has learned the content.
    const r = pushRequestSchema.safeParse({ token: TOKEN, body: 'Waiting', ciphertext: 'YmE=' });
    expect(r.success).toBe(false);
  });

  test('rejects a push carrying neither', () => {
    expect(pushRequestSchema.safeParse({ token: TOKEN }).success).toBe(false);
  });

  test('an absent or unknown level parses as normal so older callers keep working', () => {
    for (const level of [undefined, 'loud', '', 7]) {
      const r = pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'x', level });
      expect(r.success && r.data.level).toBe('normal');
    }
    expect(pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'x', level: 'urgent' }).data?.level).toBe('urgent');
    expect(pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'x', level: 'quiet' }).data?.level).toBe('quiet');
  });

  test('a malformed thread key is dropped rather than rejecting the push', () => {
    const r = pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'x', threadKey: 'my session!' });
    expect(r.success && r.data.threadKey).toBeUndefined();
    expect(pushRequestSchema.safeParse({ token: TOKEN, ciphertext: 'x', threadKey: 'ab12' }).data?.threadKey).toBe('ab12');
  });

  test.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex', `${'a'.repeat(63)}z`],
  ])('rejects a %s device token', (_label, token) => {
    expect(pushRequestSchema.safeParse({ token, body: 'x' }).success).toBe(false);
  });
});

describe('buildApnsPayload', () => {
  test('encrypted pushes carry no readable content and ask for NSE handling', () => {
    const payload = buildApnsPayload({ token: TOKEN, ciphertext: 'Q0lQSEVS' });
    expect(payload.aps['mutable-content']).toBe(1);
    expect(payload.e).toBe('Q0lQSEVS');
    // The visible fallback must not leak anything if decryption fails.
    expect(JSON.stringify(payload.aps)).not.toContain('Q0lQSEVS');
    expect(payload.aps.alert).toEqual({ title: 'Tether', body: 'New activity' });
  });

  test('cleartext pushes render directly without an NSE round trip', () => {
    const payload = buildApnsPayload({ token: TOKEN, title: 'alpha', body: 'Waiting for input' });
    expect(payload.aps.alert).toEqual({ title: 'alpha', body: 'Waiting for input' });
    expect(payload.aps['mutable-content']).toBeUndefined();
    expect(payload.e).toBeUndefined();
  });

  test('urgent pushes are time-sensitive with full relevance and a sound', () => {
    const { aps } = buildApnsPayload({ token: TOKEN, ciphertext: 'x', level: 'urgent' });
    expect(aps['interruption-level']).toBe('time-sensitive');
    expect(aps['relevance-score']).toBe(1);
    expect(aps.sound).toBe('default');
  });

  test('normal pushes are active with a sound, and the default when level is absent', () => {
    for (const level of ['normal', undefined] as const) {
      const { aps } = buildApnsPayload({ token: TOKEN, ciphertext: 'x', level });
      expect(aps['interruption-level']).toBe('active');
      expect(aps.sound).toBe('default');
    }
  });

  test('quiet pushes are passive and silent', () => {
    const { aps } = buildApnsPayload({ token: TOKEN, body: 'x', level: 'quiet' });
    expect(aps['interruption-level']).toBe('passive');
    expect(aps.sound).toBeUndefined();
  });

  test('thread-id is set from the opaque key only when given', () => {
    expect(buildApnsPayload({ token: TOKEN, ciphertext: 'x', threadKey: 'abc123' }).aps['thread-id']).toBe('abc123');
    expect(buildApnsPayload({ token: TOKEN, ciphertext: 'x' }).aps['thread-id']).toBeUndefined();
  });

  test('deep link rides alongside the payload when present', () => {
    const payload = buildApnsPayload({ token: TOKEN, body: 'x', deepLink: 'tether://session/a' });
    expect(payload.link).toBe('tether://session/a');
  });

  test('a maximum-size request stays within the APNs payload limit', () => {
    const payload = buildApnsPayload({ token: TOKEN, ciphertext: 'A'.repeat(3000) });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(APNS_MAX_PAYLOAD_BYTES);
  });
});

describe('classifyApnsStatus', () => {
  test.each([
    [200, 'ok'],
    [410, 'unregistered'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [400, 'bad-request'],
    [403, 'bad-request'],
  ] as const)('maps %i to %s', (status, expected) => {
    expect(classifyApnsStatus(status)).toBe(expected);
  });
});
