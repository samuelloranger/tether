import type { TerminalEmulator } from './terminal';

export interface SessionEntry {
  term: TerminalEmulator;
  sinceId: number;
  lastAppliedId: number;
}

// LRU cache of terminal emulators. Only the active session has a live WS; cached
// background emulators are frozen. The active session is always most-recently
// touched, so it is never the eviction victim (cap >= 1).
export class SessionCache {
  private map = new Map<string, SessionEntry>();
  private order: string[] = []; // most-recent first
  constructor(private cap = 3) {}

  get(id: string): SessionEntry | undefined {
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
      this.map.delete(victim);
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
