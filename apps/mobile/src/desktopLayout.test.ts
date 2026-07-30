import { describe, expect, it } from 'bun:test';
import { desktopLayout } from './desktopLayout';

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
    // Mirrors useTetherApp: diffOpen && desktopLayout(...) !== 'desktop'
    const blockKeys = (isDesktopClient: boolean, width: number, diffOpen: boolean) =>
      diffOpen && desktopLayout(isDesktopClient, width) !== 'desktop';
    expect(blockKeys(true, 1440, true)).toBe(false); // GitDrawer — terminal stays live
    expect(blockKeys(true, 700, true)).toBe(true); // compact desktop GitReview
    expect(blockKeys(false, 400, true)).toBe(true); // mobile GitReview
    expect(blockKeys(true, 700, false)).toBe(false);
  });
});
