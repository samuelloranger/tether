import { describe, expect, test } from 'bun:test';
import {
  APNS_MAX_PAYLOAD_BYTES,
  buildApnsPayload,
  classifyApnsStatus,
  pushRequestSchema,
} from './payload';

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
