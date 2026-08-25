/** Suppresses xterm auto-replies while scrollback replay is being applied. */
export function createReplayGate(idleMs = 50) {
  let replaying = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = () => {
    replaying = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      replaying = false;
      timer = null;
    }, idleMs);
  };

  return {
    isReplaying: () => replaying,
    onConnect: () => {
      replaying = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    onOutput: arm,
    onReset: () => {
      replaying = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type ReplayGate = ReturnType<typeof createReplayGate>;
