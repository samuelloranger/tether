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

export function sessionDotColor(
  session: { status: 'running' | 'stopped'; last_output_at: string | null },
  active: boolean,
): string {
  if (session.status === 'stopped') return '#64748b';
  if (!session.last_output_at) return active ? '#22c55e' : '#334155';
  const time = Date.parse(session.last_output_at.replace(' ', 'T') + 'Z');
  return active || (!Number.isNaN(time) && Date.now() - time < 10_000) ? '#22c55e' : '#334155';
}
