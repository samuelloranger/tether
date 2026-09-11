import { describe, expect, it } from 'bun:test';
import { relativeSince } from './sessionStrip';

const NOW = Date.parse('2026-08-26T18:00:00Z');

describe('relativeSince', () => {
  it('reports seconds, minutes, hours and days', () => {
    expect(relativeSince('2026-08-26T17:59:56Z', NOW)).toBe('4s');
    expect(relativeSince('2026-08-26T17:48:00Z', NOW)).toBe('12m');
    expect(relativeSince('2026-08-26T15:00:00Z', NOW)).toBe('3h');
    expect(relativeSince('2026-08-24T18:00:00Z', NOW)).toBe('2d');
  });

  // SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Parsed
  // as-is that reads as LOCAL time, so every age came out wrong by the offset.
  it('treats a zone-less SQLite timestamp as UTC, not local', () => {
    expect(relativeSince('2026-08-26 17:48:00', NOW)).toBe('12m');
  });

  it('never renders a negative age when a clock runs ahead', () => {
    expect(relativeSince('2026-08-26T18:00:30Z', NOW)).toBe('0s');
  });

  it('falls back to a dash rather than NaN', () => {
    expect(relativeSince(null, NOW)).toBe('—');
    expect(relativeSince(undefined, NOW)).toBe('—');
    expect(relativeSince('not a date', NOW)).toBe('—');
  });
});
