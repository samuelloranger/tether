// The terminal renderer is a page inside a WebView, not a React component, and
// it fails in ways a component cannot: iOS reclaims a backgrounded WKWebView's
// content process, a load can fail outright, or the page can come up but never
// finish booting. In every one of those cases the old code did the same thing —
// nothing. RendererQueue kept buffering output into pendingWrites, the WebView
// painted its own opaque white, and the app looked alive with a permanently
// blank terminal until the user force-quit it.
//
// Readiness is therefore a state machine with a deadline on every transition
// that depends on the page answering:
//
//   loading  the page is booting. It must post `ready` before READY_DEADLINE_MS
//            or it is presumed dead. This covers the case the foreground probe
//            alone missed: a renderer that never comes up at MOUNT.
//   ready    the page answers. Foregrounding probes it, because that is when a
//            reclaimed content process surfaces, and a probe that goes
//            unanswered within PROBE_TIMEOUT_MS means the page is gone.
//   stalled  it did not come back after MAX_AUTO_REMOUNTS attempts. Surfaced to
//            the user rather than retried forever — an endless remount loop
//            burns battery and still shows a blank rectangle.
export type RendererStatus = 'loading' | 'ready' | 'stalled';

export const READY_DEADLINE_MS = 8000;
export const PROBE_TIMEOUT_MS = 2500;
export const MAX_AUTO_REMOUNTS = 3;

type Timer = ReturnType<typeof setTimeout>;

export interface RendererLifecycleHooks {
  // Ask the live page to prove it is running.
  probe: () => void;
  // Throw the page away and mount a fresh one.
  remount: () => void;
  onStatus: (status: RendererStatus) => void;
}

export class RendererLifecycle {
  private status: RendererStatus = 'loading';
  private timer: Timer | null = null;
  private autoRemounts = 0;

  constructor(
    private hooks: RendererLifecycleHooks,
    private options: {
      readyDeadlineMs?: number;
      probeTimeoutMs?: number;
      maxAutoRemounts?: number;
      schedule?: (fn: () => void, ms: number) => Timer;
      cancel?: (timer: Timer) => void;
    } = {},
  ) {}

  get current(): RendererStatus {
    return this.status;
  }

  /** The WebView began loading a page (initial mount or a remount). */
  loadStarted(): void {
    this.setStatus('loading');
    this.arm(this.options.readyDeadlineMs ?? READY_DEADLINE_MS);
  }

  /** The page posted `ready`: it is booted and accepting commands. */
  pageReady(): void {
    this.clear();
    this.autoRemounts = 0;
    this.setStatus('ready');
  }

  /** Any message at all proves the content process is alive. */
  sawMessage(): void {
    if (this.status === 'ready') this.clear();
  }

  /** The app came back to the foreground — the moment a reclaimed page shows up. */
  foregrounded(): void {
    if (this.status !== 'ready' || this.timer) return;
    this.arm(this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    this.hooks.probe();
  }

  /** The content/render process died, or the load errored. */
  crashed(): void {
    this.recover();
  }

  /** The user asked for another go from the stalled UI. */
  retry(): void {
    this.autoRemounts = 0;
    this.recover();
  }

  dispose(): void {
    this.clear();
  }

  private recover(): void {
    this.clear();
    if (this.autoRemounts >= (this.options.maxAutoRemounts ?? MAX_AUTO_REMOUNTS)) {
      this.setStatus('stalled');
      return;
    }
    this.autoRemounts++;
    this.setStatus('loading');
    this.hooks.remount();
  }

  private arm(ms: number): void {
    this.clear();
    const schedule = this.options.schedule ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      this.recover();
    }, ms);
  }

  private clear(): void {
    if (this.timer) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private setStatus(next: RendererStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.hooks.onStatus(next);
  }
}
