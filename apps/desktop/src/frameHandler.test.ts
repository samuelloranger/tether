import { describe, expect, it } from 'bun:test';
import { applyServerFrame, type FrameSink } from './frameHandler';

function collectSink(): FrameSink & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => {
      chunks.push(chunk);
    },
    reset: () => {
      chunks.length = 0;
    },
  };
}

describe('applyServerFrame', () => {
  it('applies replay frames after the cursor is reset for a fresh emulator', () => {
    const sink = collectSink();
    const replay = JSON.stringify({ type: 'output', id: 50, chunk: 'prompt> ' });

    const dropped = applyServerFrame(sink, replay, 121_257);
    expect(dropped.kind).toBe('none');
    expect(sink.chunks).toEqual([]);

    const applied = applyServerFrame(sink, replay, 0);
    expect(applied.kind).toBe('output');
    expect(applied.lastAppliedId).toBe(50);
    expect(sink.chunks).toEqual(['prompt> ']);
  });

  it('drops overlapping replay without advancing the cursor', () => {
    const sink = collectSink();
    const frame = JSON.stringify({ type: 'output', id: 5, chunk: 'x' });

    expect(applyServerFrame(sink, frame, 10).kind).toBe('none');
    expect(sink.chunks).toEqual([]);
    expect(applyServerFrame(sink, frame, 10).lastAppliedId).toBe(10);
  });

  it('rewinds the cursor on reset', () => {
    const sink = collectSink();
    sink.write('old');
    const reset = applyServerFrame(sink, JSON.stringify({ type: 'reset' }), 99);
    expect(reset.kind).toBe('reset');
    expect(reset.lastAppliedId).toBe(0);
  });
});
