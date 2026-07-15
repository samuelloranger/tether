import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DESKTOP_NAVIGATION_MODE,
  desktopNavigationLabel,
  parseDesktopNavigationMode,
  reservedNavigationWidth,
  sessionActivity,
} from './desktopNavigation';

describe('desktop navigation mode', () => {
  it('accepts only the three persisted modes and defaults malformed values', () => {
    expect(parseDesktopNavigationMode('sidebar')).toBe('sidebar');
    expect(parseDesktopNavigationMode('hover')).toBe('hover');
    expect(parseDesktopNavigationMode('tabs')).toBe('tabs');
    expect(parseDesktopNavigationMode(null)).toBe(DEFAULT_DESKTOP_NAVIGATION_MODE);
    expect(parseDesktopNavigationMode('drawer')).toBe(DEFAULT_DESKTOP_NAVIGATION_MODE);
  });

  it('reserves pane width only for the persistent sidebar', () => {
    expect(reservedNavigationWidth('sidebar')).toBe(264);
    expect(reservedNavigationWidth('hover')).toBe(0);
    expect(reservedNavigationWidth('tabs')).toBe(0);
  });

  it('prioritizes stopped state and marks only the active running session as live', () => {
    expect(sessionActivity({ status: 'stopped', last_output_at: null }, true)).toBe('stopped');
    expect(sessionActivity({ status: 'running', last_output_at: null }, true)).toBe('live');
    expect(sessionActivity({ status: 'running', last_output_at: null }, false)).toBe('idle');
  });

  it('uses the menu labels agreed for each navigation mode', () => {
    expect(desktopNavigationLabel('sidebar')).toBe('Sidebar');
    expect(desktopNavigationLabel('hover')).toBe('On hover');
    expect(desktopNavigationLabel('tabs')).toBe('Tabs');
  });
});
