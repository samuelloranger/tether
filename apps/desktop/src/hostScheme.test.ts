import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { forgetHostScheme, hostScheme, recordHostScheme } from './hostScheme';
import { type HostProfile, httpOriginFor } from './types';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('hostScheme', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('records and reads back a scheme', () => {
    recordHostScheme('host-1', 'https');
    expect(hostScheme('host-1', '8085')).toBe('https');
  });

  it('forgets a recorded scheme', () => {
    recordHostScheme('host-1', 'https');
    forgetHostScheme('host-1');
    expect(hostScheme('host-1', '8085')).toBe('http');
  });

  it('falls back to port 443/8443 for https', () => {
    expect(hostScheme('unknown', '443')).toBe('https');
    expect(hostScheme('unknown', '8443')).toBe('https');
    expect(hostScheme('unknown', '8085')).toBe('http');
  });
});

describe('httpOriginFor', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('uses recorded https scheme even on port 8085', () => {
    const profile: HostProfile = {
      id: 'host-1',
      name: 'box',
      color: '#000',
      host: '192.168.1.9',
      port: '8085',
      identityName: 'box',
      order: 0,
    };
    recordHostScheme('host-1', 'https');
    expect(httpOriginFor(profile)).toBe('https://192.168.1.9:8085');
  });
});
