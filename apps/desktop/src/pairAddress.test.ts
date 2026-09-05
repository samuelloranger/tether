import { describe, expect, it } from 'bun:test';
import { parsePairAddress } from './pairAddress';

describe('parsePairAddress', () => {
  it('splits host:port and builds the pairing WebSocket URL', () => {
    const parsed = parsePairAddress('192.168.1.5:8085');
    expect(parsed).toEqual({
      ok: true,
      scheme: 'http',
      host: '192.168.1.5',
      port: '8085',
      wsAddress: 'ws://192.168.1.5:8085/api/noise/pair',
    });
  });

  it('bare host defaults to 8085 http/ws', () => {
    const parsed = parsePairAddress('homelab.local');
    expect(parsed).toEqual({
      ok: true,
      scheme: 'http',
      host: 'homelab.local',
      port: '8085',
      wsAddress: 'ws://homelab.local:8085/api/noise/pair',
    });
  });

  it('strips a scheme and any path before rebuilding the URL', () => {
    const parsed = parsePairAddress('ws://10.0.0.2:9000/whatever');
    expect(parsed).toEqual({
      ok: true,
      scheme: 'http',
      host: '10.0.0.2',
      port: '9000',
      wsAddress: 'ws://10.0.0.2:9000/api/noise/pair',
    });
  });

  it('port 8443 without scheme is https/wss', () => {
    const parsed = parsePairAddress('box:8443');
    expect(parsed.ok && parsed.scheme).toBe('https');
    expect(parsed.ok && parsed.port).toBe('8443');
    expect(parsed.ok && parsed.wsAddress).toBe('wss://box:8443/api/noise/pair');
  });

  it('https without port is 443 not 8443', () => {
    const parsed = parsePairAddress('https://box');
    expect(parsed).toMatchObject({ ok: true, scheme: 'https', host: 'box', port: '443' });
    expect(parsed.ok && parsed.wsAddress).toBe('wss://box:443/api/noise/pair');
  });

  it('explicit https on 8085 stays https/wss', () => {
    const parsed = parsePairAddress('https://192.168.1.9:8085');
    expect(parsed.ok && parsed.scheme).toBe('https');
    expect(parsed.ok && parsed.wsAddress).toBe('wss://192.168.1.9:8085/api/noise/pair');
  });

  it('http://host:8085 stays http/ws', () => {
    const parsed = parsePairAddress('http://box:8085');
    expect(parsed.ok && parsed.wsAddress).toBe('ws://box:8085/api/noise/pair');
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
