import { describe, expect, it } from 'bun:test';
import { resolveScheme } from './hostScheme';
import { type HostProfile, httpOriginFor } from './types';

function profile(port: string, scheme?: 'http' | 'https'): HostProfile {
  return {
    id: 'host-1',
    name: 'box',
    color: '#000',
    host: '192.168.1.9',
    port,
    identityName: 'box',
    order: 0,
    scheme,
  };
}

describe('resolveScheme', () => {
  it('honours a recorded scheme regardless of port', () => {
    expect(resolveScheme('https', '8085')).toBe('https');
    expect(resolveScheme('http', '443')).toBe('http');
  });

  it('falls back to the port when no scheme is recorded', () => {
    expect(resolveScheme(undefined, '443')).toBe('https');
    expect(resolveScheme(undefined, '8443')).toBe('https');
    expect(resolveScheme(undefined, '8085')).toBe('http');
    expect(resolveScheme(null, '8085')).toBe('http');
  });
});

describe('httpOriginFor', () => {
  it('uses a recorded https scheme even on port 8085', () => {
    expect(httpOriginFor(profile('8085', 'https'))).toBe('https://192.168.1.9:8085');
  });

  it('falls back to the port for a profile with no scheme', () => {
    expect(httpOriginFor(profile('443'))).toBe('https://192.168.1.9:443');
    expect(httpOriginFor(profile('8085'))).toBe('http://192.168.1.9:8085');
  });
});
