/**
 * Decides whether an xterm auto-reply should be sent back to the PTY.
 *
 * The problem: replayed scrollback contains terminal QUERIES from the past —
 * a Primary Device Attributes request (ESC[c), a cursor position request
 * (ESC[6n). xterm.js answers them, and if the client forwards that answer it
 * lands on the LIVE shell as if typed. Observed on screen as `1;2c1;2cclear`
 * followed by "command not found".
 *
 * Two rules, and both matter:
 *
 * 1. Only auto-replies are ever suppressed, never user keystrokes. The caller
 *    tells them apart by whether the data arrived while xterm was parsing
 *    server output (see `FrameSinkHooks`). Dropping `onData` wholesale would
 *    swallow real typing during any busy output — a build log or a TUI would
 *    make the terminal silently unresponsive.
 *
 * 2. The suppression window is BOUNDED. An idle gap alone is not enough: if it
 *    re-armed on every output frame, a long-running live session would keep the
 *    gate shut forever and a TUI that asks for the cursor position mid-render
 *    would wait for an answer that never comes. So the window can only be held
 *    open for `maxMs` after a connect or reset — which is what a replay
 *    actually is — and after that replies flow normally no matter how much
 *    output is streaming.
 */
export function createReplayGate(idleMs = 50, maxMs = 3000) {
  let replaying = true;
  let windowStart = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const open = () => {
    replaying = false;
    clear();
  };

  const begin = () => {
    replaying = true;
    windowStart = Date.now();
    clear();
  };

  return {
    /** True only while replayed output is still being applied. */
    isReplaying: () => replaying,

    /** A fresh connection replays from the client's cursor. */
    onConnect: begin,

    /** A server `reset` wipes the emulator and replays a coherent tail. */
    onReset: begin,

    /**
     * Each applied output frame re-arms the idle timer, but never past the
     * absolute window — see rule 2 above.
     */
    onOutput: () => {
      if (!replaying) return;
      if (Date.now() - windowStart >= maxMs) {
        open();
        return;
      }
      clear();
      timer = setTimeout(open, idleMs);
    },

    dispose: clear,
  };
}

export type ReplayGate = ReturnType<typeof createReplayGate>;
