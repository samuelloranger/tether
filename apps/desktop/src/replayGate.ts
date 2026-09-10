/**
 * Suppresses xterm auto-replies to queries in replayed scrollback (they'd land on the
 * live shell as typed), never keystrokes. Bounded to `maxMs` so a busy session can't stick.
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

    /** Each output frame re-arms the idle timer, but never past the absolute window. */
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
