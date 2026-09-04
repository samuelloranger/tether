import { describe, expect, it } from 'bun:test';
import {
  CODE_ALPHABET,
  formatPairingInput,
  groupPairingCode,
  isCompletePairingCode,
  normalizePairingCode,
} from './pairingCode';

describe('CODE_ALPHABET', () => {
  it('is Crockford base32 — A–Z minus I, L, O, U, plus digits', () => {
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CODE_ALPHABET).not.toContain('I');
    expect(CODE_ALPHABET).not.toContain('L');
    expect(CODE_ALPHABET).not.toContain('O');
    expect(CODE_ALPHABET).not.toContain('U');
  });
});

describe('normalizePairingCode', () => {
  it('folds case, dashes, spaces, and the I/L/O look-alikes', () => {
    // o->0, l->1, i->1, b->B — same folding as the Rust code::normalize.
    expect(normalizePairingCode('olib-2345-6789')).toBe('011B23456789');
  });

  it('accepts a grouped, mixed-case, space-separated code', () => {
    expect(normalizePairingCode('7qf4 km9p x3tv')).toBe('7QF4KM9PX3TV');
  });

  it('rejects the wrong length', () => {
    expect(normalizePairingCode('ABC')).toBeNull();
    expect(normalizePairingCode('7QF4-KM9P-X3TV-EXTRA')).toBeNull();
  });

  it('rejects characters outside the alphabet', () => {
    expect(normalizePairingCode('!23456789ABC')).toBeNull();
    // U is not folded and is not in the alphabet.
    expect(normalizePairingCode('U23456789ABC')).toBeNull();
  });
});

describe('groupPairingCode', () => {
  it('inserts two dashes to make 4·4·4 blocks', () => {
    expect(groupPairingCode('011B23456789')).toBe('011B-2345-6789');
    expect(groupPairingCode('7QF4KM9PX3TV')).toBe('7QF4-KM9P-X3TV');
  });

  it('groups a partial code without a trailing dash', () => {
    expect(groupPairingCode('7QF4KM')).toBe('7QF4-KM');
    expect(groupPairingCode('7QF4')).toBe('7QF4');
  });
});

describe('formatPairingInput', () => {
  it('uppercases, folds, and regroups as the user types', () => {
    expect(formatPairingInput('7qf4km9px3tv')).toBe('7QF4-KM9P-X3TV');
    expect(formatPairingInput('olib23456789')).toBe('011B-2345-6789');
  });

  it('strips stray dashes, spaces, and out-of-alphabet characters', () => {
    expect(formatPairingInput('7QF4-KM')).toBe('7QF4-KM');
    expect(formatPairingInput('7q f4!k')).toBe('7QF4-K');
  });

  it('caps the input at 12 characters', () => {
    expect(formatPairingInput('7QF4KM9PX3TVEXTRA')).toBe('7QF4-KM9P-X3TV');
  });
});

describe('isCompletePairingCode', () => {
  it('is true only for a complete 12-char code', () => {
    expect(isCompletePairingCode('7QF4-KM9P-X3TV')).toBe(true);
    expect(isCompletePairingCode('7QF4-KM9P')).toBe(false);
    expect(isCompletePairingCode('')).toBe(false);
  });
});
