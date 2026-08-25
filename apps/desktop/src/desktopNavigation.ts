export const PANEL_W = 264;

export function isRecentlyActive(ts: string | null): boolean {
  if (!ts) return false;
  const t = Date.parse(`${ts.replace(' ', 'T')}Z`);
  return !Number.isNaN(t) && Date.now() - t < 10_000;
}
