// A docked session sidebar needs 264 px and the terminal needs roughly 456 px
// before its controls and readable command output start competing for space.
// Below that point a desktop window uses the compact shell rather than trying
// to squeeze desktop chrome into a phone-sized viewport.
export const MIN_DESKTOP_LAYOUT_WIDTH = 720;

export function desktopLayout(isDesktopClient: boolean, width: number): 'desktop' | 'compact' {
  return isDesktopClient && width >= MIN_DESKTOP_LAYOUT_WIDTH ? 'desktop' : 'compact';
}

export function sidebarDocked(desktopUi: boolean, sidebarPinned: boolean): boolean {
  return desktopUi && sidebarPinned;
}

export function sidebarVisible(docked: boolean, drawerOpen: boolean): boolean {
  return docked || drawerOpen;
}

export function showTitleBarDrawerMenu(desktopUi: boolean, sidebarPinned: boolean): boolean {
  return desktopUi && !sidebarPinned;
}
