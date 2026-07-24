import type { DiffSummary } from './diffModel';
import type { TerminalEngine } from './terminalEngine';

export interface SessionEntry {
  term: TerminalEngine;
  sinceId: number;
  lastAppliedId: number;
  diffSummary: DiffSummary;
  // Last emulator bell/notify counts we already turned into an OS
  // notification, so a desktop notification fires once per new bell / OSC
  // notify edge (not on every output frame). Tracked per session because
  // every cache-resident tab streams live, not just the active one.
  lastBellCount: number;
  lastNotifyCount: number;
}

// LRU cache of terminal emulators. Every cache-resident session keeps its own
// live WS and streams in the background; only input/clipboard are gated to the
// active tab. The active session is always most-recently touched, so it is
// never the eviction victim (cap >= 1).
export class SessionCache {
  private map = new Map<string, SessionEntry>();
  private order: string[] = []; // most-recent first
  private cap: number;
  constructor(
    cap = 3,
    private onEvict?: (id: string, entry: SessionEntry) => void,
  ) {
    // Guard against cap < 1, which would make touch() evict the entry it just
    // created.
    this.cap = Math.max(1, cap);
  }

  get(id: string): SessionEntry | undefined {
    return this.map.get(id);
  }
  // Read an entry without touching LRU order — safe to call during render.
  peek(id: string): SessionEntry | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }

  // Get-or-create `id`, mark it most-recently-used, evict beyond cap.
  touch(id: string, make: () => SessionEntry): SessionEntry {
    let e = this.map.get(id);
    if (!e) {
      e = make();
      this.map.set(id, e);
    }
    this.order = [id, ...this.order.filter((x) => x !== id)];
    while (this.order.length > this.cap) {
      const victim = this.order.pop()!;
      const victimEntry = this.map.get(victim);
      this.map.delete(victim);
      if (victimEntry) this.onEvict?.(victim, victimEntry);
    }
    return e;
  }

  delete(id: string): void {
    this.map.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  ids(): string[] {
    return [...this.order];
  }
}

export function nextTermId(existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const m = /^term-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `term-${max + 1}`;
}
