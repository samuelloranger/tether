import { describe, expect, it } from 'bun:test';
import { groupFingerprint } from './groupFingerprint';

describe('groupFingerprint', () => {
  it('splits a 64-hex fingerprint into space-separated 4-char blocks', () => {
    const hex = '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';
    const grouped = groupFingerprint(hex);
    expect(grouped).toBe(
      '6668 7aad f862 bd77 6c8f c18b 8e9f 8e20 0897 1485 6ee2 33b3 902a 591d 0d5f 2925',
    );
    expect(grouped.split(' ')).toHaveLength(16);
  });

  it('keeps a trailing partial block intact', () => {
    expect(groupFingerprint('abcde')).toBe('abcd e');
  });

  it('returns an empty string unchanged rather than throwing', () => {
    expect(groupFingerprint('')).toBe('');
  });
});
