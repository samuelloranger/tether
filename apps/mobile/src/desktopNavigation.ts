export type DesktopNavigationMode = 'sidebar' | 'hover' | 'tabs';

export const DEFAULT_DESKTOP_NAVIGATION_MODE: DesktopNavigationMode = 'sidebar';
export const DESKTOP_NAVIGATION_STORAGE_KEY = 'tether_desktop_navigation_mode';

export function parseDesktopNavigationMode(value: string | null): DesktopNavigationMode {
  return value === 'sidebar' || value === 'hover' || value === 'tabs'
    ? value
    : DEFAULT_DESKTOP_NAVIGATION_MODE;
}

export function reservedNavigationWidth(mode: DesktopNavigationMode): number {
  return mode === 'sidebar' ? 264 : 0;
}
