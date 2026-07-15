export type DesktopNavigationMode = 'sidebar' | 'hover' | 'tabs';

export const DEFAULT_DESKTOP_NAVIGATION_MODE: DesktopNavigationMode = 'sidebar';
export const DESKTOP_NAVIGATION_STORAGE_KEY = 'tether_desktop_navigation_mode';

// Shared with SessionDrawer's docked sidebar so both the fixed sidebar and the
// hover-panel width stay a single source of truth.
export const PANEL_W = 264;

export function isRecentlyActive(ts: string | null): boolean {
  if (!ts) return false;
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; treat as UTC.
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  return !Number.isNaN(t) && Date.now() - t < 10_000;
}

export function parseDesktopNavigationMode(value: string | null): DesktopNavigationMode {
  return value === 'sidebar' || value === 'hover' || value === 'tabs'
    ? value
    : DEFAULT_DESKTOP_NAVIGATION_MODE;
}

export function reservedNavigationWidth(mode: DesktopNavigationMode): number {
  return mode === 'sidebar' ? PANEL_W : 0;
}

export function desktopNavigationLabel(mode: DesktopNavigationMode): string {
  return mode === 'hover' ? 'On hover' : mode === 'sidebar' ? 'Sidebar' : 'Tabs';
}

export function sessionActivity(
  session: { status: 'running' | 'stopped'; last_output_at: string | null },
  active: boolean,
): 'stopped' | 'live' | 'idle' {
  if (session.status === 'stopped') return 'stopped';
  return active || isRecentlyActive(session.last_output_at) ? 'live' : 'idle';
}
