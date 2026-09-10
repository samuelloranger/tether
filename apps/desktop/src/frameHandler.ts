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

/**
 * Brackets xterm's SERVER-output parsing so a parser-generated auto-reply
 * (DA/cursor-position) can be told apart from a user keystroke on `onData`.
 */
export interface FrameSinkHooks {
  beginWrite(): void;
  endWrite(): void;
  /** Fired after `term.reset()` so callers can drop mode mirrors (e.g. mouse SGR). */
  onReset?(): void;
}

export function createFrameSink(term: Terminal, hooks?: FrameSinkHooks): FrameSink {
  return {
    write: (chunk) => {
      hooks?.beginWrite();
      term.write(chunk, () => hooks?.endWrite());
    },
    reset: () => {
      term.reset();
      hooks?.onReset?.();
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
    if (
      activity === 'working' ||
      activity === 'waiting' ||
      activity === 'done' ||
      activity === 'idle'
    ) {
      return { lastAppliedId, kind: 'activity', activity };
    }
  }
  return { lastAppliedId, kind: 'none' };
}
