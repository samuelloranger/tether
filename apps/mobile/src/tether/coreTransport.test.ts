import { describe, expect, it } from 'bun:test';
import { buildCoreConnectArgs, coreTransportEnabled } from './coreTransport';

describe('coreTransportEnabled', () => {
  it('is off when the flag is unset', () => {
    expect(coreTransportEnabled({ getItem: () => null })).toBe(false);
  });

  it('is on only for the exact opt-in value', () => {
    expect(coreTransportEnabled({ getItem: () => '1' })).toBe(true);
    expect(coreTransportEnabled({ getItem: () => 'true' })).toBe(false);
  });

  // A storage backend that throws (private mode, disabled site data) must not
  // take the transport down with it.
  it('is off when storage throws', () => {
    expect(
      coreTransportEnabled({
        getItem: () => {
          throw new Error('nope');
        },
      }),
    ).toBe(false);
  });

  it('is off when there is no storage at all', () => {
    expect(coreTransportEnabled(undefined)).toBe(false);
  });
});

describe('buildCoreConnectArgs', () => {
  // The core owns sinceId, so it must NOT appear in the invoke payload — that
  // absence is the whole point of the spike.
  it('sends the origin and session, never sinceId', () => {
    const args = buildCoreConnectArgs('conn-3', 'ws://10.0.0.5:8085', 'pw', {
      sessionId: 'build',
      sinceId: 512,
      cols: 120,
      rows: 40,
    });
    expect(args).toEqual({
      connId: 'conn-3',
      baseWsUrl: 'ws://10.0.0.5:8085',
      password: 'pw',
      sessionId: 'build',
      cols: 120,
      rows: 40,
    });
    expect('sinceId' in args).toBe(false);
  });

  it('defaults cols and rows when the caller omits them', () => {
    const args = buildCoreConnectArgs('c', 'ws://h:1', '', { sessionId: 's' });
    expect(args.cols).toBe(80);
    expect(args.rows).toBe(24);
  });
});
