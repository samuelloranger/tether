import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DESKTOP_NAVIGATION_MODE,
  parseDesktopNavigationMode,
  reservedNavigationWidth,
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
});
