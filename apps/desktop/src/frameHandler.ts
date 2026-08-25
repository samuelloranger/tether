import type { Terminal } from '@xterm/xterm';
import type { SessionActivity } from './activity';

export interface FrameSink {
  write(chunk: string): void;
  reset(): void;
}

export type FrameApplyResult = {
  lastAppliedId: number;
  kind: 'none' | 'output' | 'reset' | 'title' | 'activity';
  title?: string;
  activity?: SessionActivity;
};

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

export function applyServerFrame(
  sink: FrameSink,
  raw: string,
  lastAppliedId: number,
): FrameApplyResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { lastAppliedId, kind: 'none' };
  }
  if (typeof payload !== 'object' || payload === null) return { lastAppliedId, kind: 'none' };
  const frame = payload as Record<string, unknown>;
  if (frame.type === 'output') {
    if (typeof frame.id !== 'number' || frame.id <= lastAppliedId)
      return { lastAppliedId, kind: 'none' };
    if (typeof frame.chunk !== 'string') return { lastAppliedId, kind: 'none' };
    sink.write(frame.chunk);
    return { lastAppliedId: frame.id, kind: 'output' };
  }
  if (frame.type === 'reset') {
    sink.reset();
    return { lastAppliedId: 0, kind: 'reset' };
  }
  if (frame.type === 'title' && typeof frame.title === 'string') {
    return { lastAppliedId, kind: 'title', title: frame.title };
  }
  if (frame.type === 'activity' && typeof frame.activity === 'string') {
    const activity = frame.activity;
    if (activity === 'working' || activity === 'waiting' || activity === 'idle') {
      return { lastAppliedId, kind: 'activity', activity };
    }
  }
  return { lastAppliedId, kind: 'none' };
}
