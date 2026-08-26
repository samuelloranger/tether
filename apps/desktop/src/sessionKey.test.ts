import { describe, expect, it } from 'bun:test';
import { parseSessionKey, sessionKey } from './sessionKey';

describe('sessionKey', () => {
  it('qualifies a session id by host', () => {
    expect(sessionKey('studio', 'term-1')).toBe('studio:term-1');
  });

  it('round-trips host-qualified keys', () => {
    expect(parseSessionKey('studio:term-1')).toEqual({ hostId: 'studio', sessionId: 'term-1' });
  });

  it('rejects keys without a host or session', () => {
    expect(() => parseSessionKey('nocolon')).toThrow();
    expect(() => parseSessionKey(':term-1')).toThrow();
    expect(() => parseSessionKey('studio:')).toThrow();
  });
});
