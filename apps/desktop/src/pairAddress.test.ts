import { describe, expect, it } from 'bun:test';
import { parsePairAddress } from './pairAddress';

describe('parsePairAddress', () => {
  it('splits host:port and builds the pairing WebSocket URL', () => {
    const parsed = parsePairAddress('192.168.1.5:8085');
    expect(parsed).toEqual({
      ok: true,
      host: '192.168.1.5',
      port: '8085',
      wsAddress: 'ws://192.168.1.5:8085/api/noise/pair',
    });
  });

  it('defaults the port to 8085 when none is given', () => {
    const parsed = parsePairAddress('homelab.local');
    expect(parsed).toEqual({
      ok: true,
      host: 'homelab.local',
      port: '8085',
      wsAddress: 'ws://homelab.local:8085/api/noise/pair',
    });
  });

  it('strips a scheme and any path before rebuilding the URL', () => {
    const parsed = parsePairAddress('ws://10.0.0.2:9000/whatever');
    expect(parsed).toEqual({
      ok: true,
      host: '10.0.0.2',
      port: '9000',
      wsAddress: 'ws://10.0.0.2:9000/api/noise/pair',
    });
  });

  it('rejects an empty host', () => {
    const parsed = parsePairAddress('   ');
    expect(parsed.ok).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    const parsed = parsePairAddress('host:70000');
    expect(parsed.ok).toBe(false);
  });
});
