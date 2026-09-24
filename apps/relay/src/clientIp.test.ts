import { describe, expect, test } from 'bun:test';
import { clientIpFromForwarded } from './clientIp';

describe('clientIpFromForwarded', () => {
  test('with one proxy, uses the address that proxy appended', () => {
    expect(clientIpFromForwarded('203.0.113.5', 1)).toBe('203.0.113.5');
  });

  test('ignores a spoofed leading entry', () => {
    // The attacker sends "1.2.3.4"; our proxy appends the real peer. Taking the
    // left-most value would let them rotate the header and dodge the limiter.
    expect(clientIpFromForwarded('1.2.3.4, 203.0.113.5', 1)).toBe('203.0.113.5');
  });

  test('a long forged chain still resolves to the proxy-appended address', () => {
    expect(clientIpFromForwarded('a, b, c, d, 203.0.113.5', 1)).toBe('203.0.113.5');
  });

  test('honours additional trusted hops', () => {
    // Two proxies: the client address sits one further left.
    expect(clientIpFromForwarded('1.2.3.4, 203.0.113.5, 10.0.0.1', 2)).toBe('203.0.113.5');
  });

  test('never runs off the front of the list', () => {
    expect(clientIpFromForwarded('203.0.113.5', 5)).toBe('203.0.113.5');
  });

  test('tolerates whitespace and empty entries', () => {
    expect(clientIpFromForwarded('  1.2.3.4 ,, 203.0.113.5  ', 1)).toBe('203.0.113.5');
  });

  test.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['only separators', ',,,'],
  ])('falls back to a fixed key for %s', (_label, header) => {
    // Still a stable key, so direct callers share one bucket rather than
    // getting an unlimited one each.
    expect(clientIpFromForwarded(header, 1)).toBe('direct');
  });
});
