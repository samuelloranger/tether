// A docked session sidebar needs 264 px and the terminal needs roughly 456 px
// before its controls and readable command output start competing for space.
// Below that point the compact shell is used rather than trying to squeeze a
// two-column layout into a phone-sized viewport.
export const MIN_WIDE_LAYOUT_WIDTH = 720;
/**
 * Is the viewport wide enough for the two-column shell (docked sidebar beside
 * the terminal)? Width alone — a tablet in landscape earns it just like a
 * desktop window does. This is *layout*, not *chrome*: `isDesktop` still gates
 * the title bar, mouse selection, and physical-keyboard affordances, so an iPad
 * gets the docked sidebar while keeping its header and on-screen utility bar.
 */
export function wideLayout(width: number): boolean {
  return width >= MIN_WIDE_LAYOUT_WIDTH;
}

export function desktopLayout(isDesktopClient: boolean, width: number): 'desktop' | 'compact' {
  return isDesktopClient && wideLayout(width) ? 'desktop' : 'compact';
}

export function sidebarDocked(wideUi: boolean, sidebarPinned: boolean): boolean {
  return wideUi && sidebarPinned;
}

export function sidebarVisible(docked: boolean, drawerOpen: boolean): boolean {
  return docked || drawerOpen;
}

export function showTitleBarDrawerMenu(desktopUi: boolean, sidebarPinned: boolean): boolean {
  return desktopUi && !sidebarPinned;
}
