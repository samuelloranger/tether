// The terminal renderer lives in a single WebView that is mounted once for the
// whole app lifetime — sessions switch by re-hydrating it, not by remounting.
// iOS reclaims a backgrounded WKWebView's content process, and when it does the
// page is gone: the WebView paints its own opaque white, RendererQueue keeps
// buffering output into pendingWrites forever, and the app looks alive while the
// terminal is permanently blank. onContentProcessDidTerminate is not a reliable
// signal for that (it does not always fire for a process reclaimed while the app
// was suspended), so the renderer is probed on foreground instead: ask the live
// page to answer, and if it doesn't, treat it as dead.
export const RENDERER_PROBE_TIMEOUT_MS = 2500;

type Timer = ReturnType<typeof setTimeout>;

export class RendererWatchdog {
  private timer: Timer | null = null;

  constructor(
    private probe: () => void,
    private onStall: () => void,
    private timeoutMs = RENDERER_PROBE_TIMEOUT_MS,
    private schedule: (fn: () => void, ms: number) => Timer = setTimeout,
    private cancel: (timer: Timer) => void = clearTimeout,
  ) {}

  // Ask the page to prove it's alive. Re-entrant calls while a probe is already
  // outstanding are ignored, so repeated foregrounding can't stack timers.
  check(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.onStall();
    }, this.timeoutMs);
    this.probe();
  }

  // Any message from the page proves the content process is running.
  alive(): void {
    this.stop();
  }

  stop(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
