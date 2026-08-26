interface Labelled {
  id: string;
  name?: string | null;
  auto_title?: string | null;
}

export function sessionLabel(s: Labelled): string {
  return s.name || s.auto_title || s.id;
}

/**
 * Labels for one host's sessions, with collisions broken.
 *
 * `auto_title` falls back to the working directory's name, so every session
 * started in the same repo shows the same word and the drawer becomes a list of
 * identical rows with no way to tell them apart. Only colliding labels get the
 * session id appended — a label that is already unique is left exactly as it is,
 * including one the user typed.
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
