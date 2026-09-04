import { describe, expect, test } from 'bun:test';
import type { FrameIO, ServerChannel } from './noiseChannel';
import { runNoiseSession, type SessionDeps } from './noiseSessionProtocol';
import type { FocusSubscriber } from './pty';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A fake ServerChannel whose seal/open are identity — the JSON bytes pass
 * through untouched, so tests assert the protocol logic without real crypto.
 */
function identityChannel(): ServerChannel {
  return {
    seal: (app: Uint8Array) => app,
    open: (wire: Uint8Array) => wire,
    free: () => {},
  } as unknown as ServerChannel;
}

/**
 * A scripted FrameIO: `recv` yields each queued client frame in turn, then
 * blocks forever (mimicking an idle-but-open socket). `send` records outbound
 * frames. `deliver` lets a test push a late frame to a waiting `recv`.
 */
function scriptedIo(frames: Uint8Array[]): FrameIO & {
  sent: Uint8Array[];
  deliver: (bytes: Uint8Array) => void;
} {
  const queue = [...frames];
  const sent: Uint8Array[] = [];
  let waiter: ((b: Uint8Array) => void) | null = null;
  return {
    sent,
    send: (f) => void sent.push(f),
    recv: () =>
      new Promise<Uint8Array>((resolve) => {
        const next = queue.shift();
        if (next !== undefined) resolve(next);
        else waiter = resolve;
      }),
    deliver: (bytes) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(bytes);
      } else {
        queue.push(bytes);
      }
    },
  };
}

function jsonFrame(obj: unknown): Uint8Array {
  return enc.encode(JSON.stringify(obj));
}

interface FakePty {
  deps: SessionDeps;
  starts: Array<{ id: string; command?: string; cols: number; rows: number }>;
  writes: Array<{ id: string; text: string }>;
  resizes: Array<{ id: string; cols: number; rows: number }>;
  subscriptions: Array<{ id: string; sub: FocusSubscriber }>;
  unsubscribed: number;
}

function fakePty(): FakePty {
  const state: FakePty = {
    starts: [],
    writes: [],
    resizes: [],
    subscriptions: [],
    unsubscribed: 0,
    deps: {} as SessionDeps,
  };
  state.deps = {
    startSession: (async (id, command, cols = 80, rows = 24) => {
      state.starts.push({ id, command, cols, rows });
      return {} as never;
    }) as SessionDeps['startSession'],
    subscribeToSession: ((id, sub) => {
      state.subscriptions.push({ id, sub });
      return () => {
        state.unsubscribed += 1;
      };
    }) as SessionDeps['subscribeToSession'],
    writeToSession: ((id, text) => {
      state.writes.push({ id, text });
    }) as SessionDeps['writeToSession'],
    resizeSession: ((id, _client, cols, rows) => {
      state.resizes.push({ id, cols, rows });
    }) as SessionDeps['resizeSession'],
  };
  return state;
}

describe('runNoiseSession', () => {
  test("'start' spawns the session and subscribes to it", async () => {
    const pty = fakePty();
    const io = scriptedIo([
      jsonFrame({ t: 'start', id: 's1', command: 'bash', cols: 100, rows: 40 }),
    ]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.starts).toEqual([{ id: 's1', command: 'bash', cols: 100, rows: 40 }]);
    expect(pty.subscriptions).toHaveLength(1);
    expect(pty.subscriptions[0].id).toBe('s1');
  });

  test("a PTY 'output' event is sent back sealed to the client", async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    // Drive the subscriber the way pty.ts would on live output.
    pty.subscriptions[0].sub({ type: 'output', chunk: 'hello\n', id: 7 });

    expect(io.sent).toHaveLength(1);
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({ t: 'output', chunk: 'hello\n', id: 7 });
  });

  test("a PTY 'exit' event is forwarded sealed", async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    pty.subscriptions[0].sub({ type: 'exit', exitCode: 3 });
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({ t: 'exit', id: 's1', exitCode: 3 });
  });

  test("'input' writes to the session", async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'input', id: 's1', text: 'ls\r' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.writes).toEqual([{ id: 's1', text: 'ls\r' }]);
  });

  test("'resize' refits an attached session", async () => {
    const pty = fakePty();
    const io = scriptedIo([
      jsonFrame({ t: 'start', id: 's1' }),
      jsonFrame({ t: 'resize', id: 's1', cols: 120, rows: 50 }),
    ]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.resizes).toEqual([{ id: 's1', cols: 120, rows: 50 }]);
  });

  test('a later delivered frame is processed', async () => {
    const pty = fakePty();
    const io = scriptedIo([]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(pty.starts).toHaveLength(0);

    io.deliver(jsonFrame({ t: 'start', id: 'late' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(pty.starts.map((s) => s.id)).toEqual(['late']);
  });

  test('io.recv rejection ends the loop and unsubscribes', async () => {
    const pty = fakePty();
    // First recv resolves a start; the next blocks until we reject it, standing
    // in for a socket that closes mid-session.
    const frames = [jsonFrame({ t: 'start', id: 's1' })];
    const pendingRecv: { reject: ((e: Error) => void) | null } = { reject: null };
    const io: FrameIO = {
      send: () => {},
      recv: () => {
        const next = frames.shift();
        if (next) return Promise.resolve(next);
        return new Promise<Uint8Array>((_res, rej) => {
          pendingRecv.reject = rej;
        });
      },
    };

    const done = runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(pty.subscriptions).toHaveLength(1);

    pendingRecv.reject?.(new Error('socket closed'));
    await done; // resolves, never throws
    expect(pty.unsubscribed).toBe(1);
  });

  test('a decrypt/parse error ends the session (never throws)', async () => {
    const pty = fakePty();
    const io = scriptedIo([enc.encode('{ not json')]);
    await expect(runNoiseSession(identityChannel(), io, pty.deps)).resolves.toBeUndefined();
    expect(pty.starts).toHaveLength(0);
  });
});
