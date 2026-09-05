import { describe, expect, it } from 'bun:test';
import { noiseSessionAddress } from './noiseHosts';
import type { HostProfile } from './types';

function profile(port: string, scheme?: 'http' | 'https'): HostProfile {
  return {
    id: 'host-1',
    name: 'box',
    color: '#000',
    host: 'tether.example',
    port,
    identityName: '',
    order: 0,
    scheme,
  };
}

describe('noiseSessionAddress', () => {
  it('dials wss on the TLS ports', () => {
    expect(noiseSessionAddress(profile('443'))).toBe('wss://tether.example:443/api/noise/session');
    expect(noiseSessionAddress(profile('8443'))).toBe(
      'wss://tether.example:8443/api/noise/session',
    );
  });

  it('dials ws on a plaintext port', () => {
    expect(noiseSessionAddress(profile('8085'))).toBe('ws://tether.example:8085/api/noise/session');
  });

  it('honours a recorded https scheme on a non-standard port', () => {
    expect(noiseSessionAddress(profile('9999', 'https'))).toBe(
      'wss://tether.example:9999/api/noise/session',
    );
  });
});
