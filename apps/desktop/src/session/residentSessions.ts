export interface ResidentInput {
  drawerKeys: string[];
  visibleKeys: string[];
  lruOrder: string[];
  cap: number;
}

/** The session keys that keep a live socket. Visible panes are unconditional;
 * the rest of the budget is filled from the recency order, most-recent first.
 * Everything returned is a current drawer session. */
export function residentSessions(input: ResidentInput): string[] {
  const drawer = new Set(input.drawerKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of input.visibleKeys) {
    if (drawer.has(key) && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  for (const key of input.lruOrder) {
    if (out.length >= input.cap) break;
    if (drawer.has(key) && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  return out;
}
