import { sessionKey } from './sessionKey';

interface Labelled {
  id: string;
  name?: string | null;
  auto_title?: string | null;
}

interface HostNamed {
  id: string;
  name: string;
}

interface TabSession extends Labelled {
  hostId: string;
}

export function sessionLabel(s: Labelled): string {
  return s.name || s.auto_title || s.id;
}

/**
 * Labels for one host's sessions, collisions broken. `auto_title` falls back to the
 * dir name, so same-repo sessions collide; only colliding labels get the id appended.
 */
export function sessionLabels(sessions: Labelled[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const session of sessions) {
    const base = sessionLabel(session);
    seen.set(base, (seen.get(base) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const base = sessionLabel(session);
    labels.set(session.id, (seen.get(base) ?? 0) > 1 ? `${base} · ${session.id}` : base);
  }
  return labels;
}

/** Labels for a flat tab strip across hosts: per-host collisions get the id (like the
 *  drawer); if the result still collides across hosts, the host name is appended. */
export function tabLabels(sessions: TabSession[], hosts: HostNamed[]): Map<string, string> {
  const nameByHost = new Map(hosts.map((host) => [host.id, host.name]));
  const byHost = new Map<string, Labelled[]>();
  for (const session of sessions) {
    const list = byHost.get(session.hostId) ?? [];
    list.push(session);
    byHost.set(session.hostId, list);
  }
  const perHost = new Map<string, Map<string, string>>();
  for (const [hostId, list] of byHost) {
    perHost.set(hostId, sessionLabels(list));
  }
  const seen = new Map<string, number>();
  const keyed: Array<{ key: string; base: string; hostName: string }> = [];
  for (const session of sessions) {
    const base = perHost.get(session.hostId)?.get(session.id) ?? sessionLabel(session);
    const hostName = nameByHost.get(session.hostId) ?? session.hostId;
    seen.set(base, (seen.get(base) ?? 0) + 1);
    keyed.push({ key: sessionKey(session.hostId, session.id), base, hostName });
  }
  const labels = new Map<string, string>();
  for (const row of keyed) {
    labels.set(row.key, (seen.get(row.base) ?? 0) > 1 ? `${row.base} · ${row.hostName}` : row.base);
  }
  return labels;
}
