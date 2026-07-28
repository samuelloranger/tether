import { describe, expect, it } from 'bun:test';
import { sessionActivity } from './desktopNavigation';

describe('desktop session activity', () => {
  it('prioritizes stopped state and marks only the active running session as live', () => {
    expect(sessionActivity({ status: 'stopped', last_output_at: null }, true)).toBe('stopped');
    expect(sessionActivity({ status: 'running', last_output_at: null }, true)).toBe('live');
    expect(sessionActivity({ status: 'running', last_output_at: null }, false)).toBe('idle');
  });
});
