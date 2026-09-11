const channels = new Map<string, Set<() => void>>();

export function trackDeviceChannel(deviceId: string, close: () => void): () => void {
  let set = channels.get(deviceId);
  if (!set) {
    set = new Set();
    channels.set(deviceId, set);
  }

  let active = true;

  const invoke = () => {
    if (!active) return;
    active = false;
    set!.delete(invoke);
    if (set!.size === 0) channels.delete(deviceId);
    try {
      close();
    } catch {}
  };

  set.add(invoke);

  return () => {
    if (!active) return;
    active = false;
    set!.delete(invoke);
    if (set!.size === 0) channels.delete(deviceId);
  };
}

export function closeDeviceChannels(deviceId: string): number {
  const set = channels.get(deviceId);
  if (!set) return 0;
  const closers = [...set];
  let count = 0;
  for (const closer of closers) {
    if (set.has(closer)) {
      closer();
      count++;
    }
  }
  return count;
}
