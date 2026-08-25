import { describe, expect, it } from 'bun:test';
import {
  desktopLayout,
  showTitleBarDrawerMenu,
  sidebarDocked,
  sidebarVisible,
  wideLayout,
} from './desktopLayout';

describe('desktopLayout', () => {
  it('uses the compact shell when a desktop window cannot fit the sidebar and a usable terminal', () => {
    expect(desktopLayout(true, 719)).toBe('compact');
  });

  it('keeps desktop chrome at the minimum usable desktop width and above', () => {
    expect(desktopLayout(true, 720)).toBe('desktop');
    expect(desktopLayout(true, 1440)).toBe('desktop');
  });

  it('always uses the compact shell for native clients', () => {
    expect(desktopLayout(false, 1440)).toBe('compact');
  });

  it('blocks terminal key forwarding only for full Changes takeovers', () => {
    // Mirrors TerminalScreen: diffOpen && desktopLayout(...) !== 'desktop'
    const blockKeys = (isDesktopClient: boolean, width: number, diffOpen: boolean) =>
      diffOpen && desktopLayout(isDesktopClient, width) !== 'desktop';
    expect(blockKeys(true, 1440, true)).toBe(false); // GitDrawer — terminal stays live
    expect(blockKeys(true, 700, true)).toBe(true); // compact desktop GitReview
    expect(blockKeys(false, 400, true)).toBe(true); // mobile GitReview
    expect(blockKeys(true, 700, false)).toBe(false);
  });
});

describe('sidebar pin gating', () => {
  it('docks only on wide desktop when pinned', () => {
    expect(sidebarDocked(true, true)).toBe(true);
    expect(sidebarDocked(true, false)).toBe(false);
    expect(sidebarDocked(false, true)).toBe(false);
  });

  it('is visible when docked or when the overlay is open', () => {
    expect(sidebarVisible(true, false)).toBe(true);
    expect(sidebarVisible(false, true)).toBe(true);
    expect(sidebarVisible(false, false)).toBe(false);
  });

  it('shows the title-bar drawer menu only on wide desktop when unpinned', () => {
    expect(showTitleBarDrawerMenu(true, false)).toBe(true);
    expect(showTitleBarDrawerMenu(true, true)).toBe(false);
    expect(showTitleBarDrawerMenu(false, false)).toBe(false);
  });
});

describe('wideLayout', () => {
  it('is width-only, so a native tablet earns the two-column shell', () => {
    expect(wideLayout(719)).toBe(false);
    expect(wideLayout(720)).toBe(true);
    // iPad mini portrait (744) and iPad 11" portrait (834) both qualify.
    expect(wideLayout(744)).toBe(true);
    expect(wideLayout(834)).toBe(true);
  });

  it('leaves phone-sized viewports compact', () => {
    expect(wideLayout(390)).toBe(false);
    expect(wideLayout(440)).toBe(false);
  });

  it('docks the sidebar on a pinned tablet even though it is not a desktop client', () => {
    const wideUi = wideLayout(834);
    expect(desktopLayout(false, 834)).toBe('compact'); // no title bar, keeps mobile chrome
    expect(sidebarDocked(wideUi, true)).toBe(true);
  });
});
