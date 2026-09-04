import { describe, expect, test } from 'bun:test';
import { decodeClientMessage, decodeServerMessage, encodeMessage } from './noiseRpc';

describe('rpc codec', () => {
  test('req head round-trips', () => {
    const msg = {
      t: 'req' as const,
      id: 1,
      method: 'GET',
      path: '/api/sessions?x=1',
      headers: { accept: 'application/json' },
      hasBody: false,
    };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  test('res + body + end round-trip', () => {
    const res = {
      t: 'res' as const,
      id: 2,
      status: 200,
      headers: { 'content-type': 'application/json' },
    };
    const body = { t: 'res.body' as const, id: 2, seq: 0, b64: btoa('hello') };
    const end = { t: 'res.end' as const, id: 2 };
    expect(decodeServerMessage(encodeMessage(res))).toEqual(res);
    expect(decodeServerMessage(encodeMessage(body))).toEqual(body);
    expect(decodeServerMessage(encodeMessage(end))).toEqual(end);
  });

  test('decode rejects unknown type and bad json', () => {
    expect(() => decodeClientMessage(new TextEncoder().encode('{"t":"nope"}'))).toThrow();
    expect(() => decodeClientMessage(new TextEncoder().encode('not json'))).toThrow();
  });
});
