/**
 * The status line, deliberately narrow: the core forwards no live cwd, shell name,
 * or geometry, so this reports only what arrives — PTY key, last output, inferred state.
 */

/** Compact age of a timestamp, e.g. `4s`, `12m`, `3h`, `2d`. */
export function relativeSince(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; parsed
  // as-is that reads as local time and every age comes out hours wrong.
  const normalised = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const then = Date.parse(normalised);
  if (Number.isNaN(then)) return '—';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
