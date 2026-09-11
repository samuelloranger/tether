import { describe, expect, test } from 'bun:test';
import {
  decodeReplayCursor,
  encodeReplayCursor,
  REPLAY_START,
  replayPositionFromCursor,
} from './replayCursor';

describe('replay cursor', () => {
  test('round-trips a position', () => {
    const cursor = encodeReplayCursor('default', 4210);
    expect(decodeReplayCursor(cursor, 'default')).toBe(4210);
  });

  test('round-trips zero and large positions', () => {
    expect(decodeReplayCursor(encodeReplayCursor('s', 0), 's')).toBe(0);
    expect(decodeReplayCursor(encodeReplayCursor('s', 9_007_199_254_740_990), 's')).toBe(
      9_007_199_254_740_990,
    );
  });

  test('is opaque: the row id does not appear verbatim', () => {
    const cursor = encodeReplayCursor('default', 4210);
    expect(cursor).not.toContain('4210');
    expect(cursor).not.toContain('default');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, no padding
  });

  test('a cursor from another session is rejected', () => {
    const cursor = encodeReplayCursor('alpha', 99);
    expect(decodeReplayCursor(cursor, 'beta')).toBeNull();
    expect(decodeReplayCursor(cursor, 'alpha')).toBe(99);
  });

  test('session ids containing dots survive', () => {
    const id = 'work.tree.2';
    expect(decodeReplayCursor(encodeReplayCursor(id, 7), id)).toBe(7);
    expect(decodeReplayCursor(encodeReplayCursor(id, 7), 'work.tree')).toBeNull();
  });

  test('a tampered cursor is rejected', () => {
    const cursor = encodeReplayCursor('default', 100);
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const forged = Buffer.from(raw.replace('.100.', '.1.'), 'utf8').toString('base64url');
    expect(forged).not.toBe(cursor);
    expect(decodeReplayCursor(forged, 'default')).toBeNull();
  });

  test('garbage, empty, and missing cursors are rejected', () => {
    for (const bad of ['', 'not-a-cursor', '!!!!', 'AAAA', null, undefined]) {
      expect(decodeReplayCursor(bad, 'default')).toBeNull();
    }
  });

  test('a v1 integer sinceId is not accepted as a cursor', () => {
    expect(decodeReplayCursor('4210', 'default')).toBeNull();
  });

  test('a cursor from a future version is rejected', () => {
    const body = '2.5.default';
    const raw = Buffer.from(cursorWithChecksum(body), 'utf8').toString('base64url');
    expect(decodeReplayCursor(raw, 'default')).toBeNull();
  });

  test('replayPositionFromCursor falls back to the start of the retained tail', () => {
    expect(replayPositionFromCursor(null, 'default')).toBe(REPLAY_START);
    expect(replayPositionFromCursor('junk', 'default')).toBe(REPLAY_START);
    expect(replayPositionFromCursor(encodeReplayCursor('default', 12), 'default')).toBe(12);
  });
});

// Mirrors the module's internal checksum so the version test can mint a
// well-formed cursor that only differs by version.
function cursorWithChecksum(body: string): string {
  let hash = 0x811c9dc5;
  const text = `tether/replay-cursor${body}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}.${body}`;
}
