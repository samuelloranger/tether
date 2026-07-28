export const PANEL_W = 264;

export function isRecentlyActive(ts: string | null): boolean {
  if (!ts) return false;
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; treat as UTC.
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  return !Number.isNaN(t) && Date.now() - t < 10_000;
}

export function sessionActivity(
  session: { status: 'running' | 'stopped'; last_output_at: string | null },
  active: boolean,
): 'stopped' | 'live' | 'idle' {
  if (session.status === 'stopped') return 'stopped';
  return active || isRecentlyActive(session.last_output_at) ? 'live' : 'idle';
}
