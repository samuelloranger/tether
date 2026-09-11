/**
 * Decides which core-side per-session state to drop when the resident set
 * changes. A session that is merely switched away (still a drawer tab) keeps
 * its replay cursor so the next connect replays only what `sinceId` missed —
 * not the whole retained tail. Only a session that has actually left the drawer
 * (killed/closed) forgets its cursor, which also guards against a reused id
 * skipping its own early output.
 */
export interface ReconcileInput {
  /** `sessionKey(host,id)` for every live drawer tab. */
  drawerKeys: string[];
  /** `residentKeys(tree)` — the sessions currently mounted in a pane. */
  wantedKeys: string[];
  /** Core cache ids currently held. */
  cachedIds: string[];
}

export interface ReconcilePlan {
  /** Snapshot grids to drop. */
  deleteCache: string[];
  /** Replay cursors to forget — only truly-removed sessions. */
  forgetCursor: string[];
}

export function reconcileResidency(input: ReconcileInput): ReconcilePlan {
  const live = new Set([...input.drawerKeys, ...input.wantedKeys]);
  const stale = input.cachedIds.filter((id) => !live.has(id));
  return { deleteCache: stale, forgetCursor: stale };
}
