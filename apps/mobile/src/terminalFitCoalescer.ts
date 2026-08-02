// Coalesces the renderer's re-fit so the local grid and the PTY change size in
// the same tick.
//
// Full-screen TUIs (Claude Code, cursor-agent) repaint DIFFERENTIALLY: cursor-up
// N rows, absolute column addressing, patch only the cells that changed. That
// is only correct while the client's grid matches the size the PTY thinks it
// has. It used to not: `fit.fit()` ran on every ResizeObserver tick and resized
// the local grid immediately, while the PTY resize was debounced 60ms behind it.
// For the length of the soft keyboard's slide animation the client was at the
// new geometry and the agent was still emitting patches computed for the old
// one, so patches landed on the wrong rows — duplicated blocks, tables missing
// their header, stray fragments, all of it baked into scrollback.
//
// The debounce was on the wrong half. Coalesce the FIT instead, then resize the
// grid and tell the PTY together, and the two never disagree.
//
// Trailing edge only. A leading-edge fit would land mid-animation, at a size
// about to change again, costing a full repaint for a geometry nobody sees.

export const FIT_COALESCE_MS = 120;

type Timer = ReturnType<typeof setTimeout>;

export class FitCoalescer {
  private timer: Timer | null = null;

  constructor(
    private apply: () => void,
    private options: {
      delayMs?: number;
      schedule?: (fn: () => void, ms: number) => Timer;
      cancel?: (timer: Timer) => void;
    } = {},
  ) {}

  /** A size change was observed. Fires `apply` once the ticks stop. */
  request(): void {
    this.cancelTimer();
    const schedule = this.options.schedule ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      this.apply();
    }, this.options.delayMs ?? FIT_COALESCE_MS);
  }

  /** True while a fit is owed. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Run any owed fit right now (mount, hydrate — no animation to wait out). */
  flush(): void {
    this.cancelTimer();
    this.apply();
  }

  /** Drop any owed fit without running it. */
  dispose(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = null;
  }
}
