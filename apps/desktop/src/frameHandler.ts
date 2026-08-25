import type { Terminal } from '@xterm/xterm';

export interface FrameSink {
  write(chunk: string): void;
  reset(): void;
}

export function createFrameSink(term: Terminal): FrameSink {
  return {
    write: (chunk) => {
      term.write(chunk);
    },
    reset: () => {
      term.reset();
    },
  };
}

export function applyServerFrame(sink: FrameSink, raw: string, lastAppliedId: number): number {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return lastAppliedId;
  }
  if (typeof payload !== 'object' || payload === null) return lastAppliedId;
  const frame = payload as Record<string, unknown>;
  if (frame.type === 'output') {
    if (typeof frame.id !== 'number' || frame.id <= lastAppliedId) return lastAppliedId;
    if (typeof frame.chunk !== 'string') return lastAppliedId;
    sink.write(frame.chunk);
    return frame.id;
  }
  if (frame.type === 'reset') {
    sink.reset();
    return 0;
  }
  return lastAppliedId;
}
