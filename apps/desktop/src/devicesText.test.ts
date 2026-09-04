import { describe, expect, it } from 'bun:test';
import { lastSeenText, shortFingerprint } from './devicesText';

describe('shortFingerprint', () => {
  it('keeps the first 23 characters', () => {
    expect(shortFingerprint('ab:cd:ef:01:23:45:67:89:aa:bb')).toBe('ab:cd:ef:01:23:45:67:89');
  });

  it('returns short fingerprints unchanged', () => {
    expect(shortFingerprint('ab:cd')).toBe('ab:cd');
  });
});

describe('lastSeenText', () => {
  it('says never connected when there is no timestamp', () => {
    expect(lastSeenText({ lastSeenAt: null, lastAddress: null })).toBe('Never connected');
    expect(lastSeenText({ lastSeenAt: null, lastAddress: '10.0.0.1' })).toBe('Never connected');
  });

  it('shows the timestamp alone when no address is reported', () => {
    expect(lastSeenText({ lastSeenAt: '2026-02-02T00:00:00Z', lastAddress: null })).toBe(
      'Last seen 2026-02-02T00:00:00Z',
    );
  });

  it('appends the address when present', () => {
    expect(lastSeenText({ lastSeenAt: '2026-02-02T00:00:00Z', lastAddress: '192.168.1.2' })).toBe(
      'Last seen 2026-02-02T00:00:00Z · 192.168.1.2',
    );
  });
});
