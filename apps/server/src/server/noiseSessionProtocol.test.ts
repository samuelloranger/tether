import { describe, expect, test } from 'bun:test';
import { type AuthDevice, RegistryError } from './deviceRegistry';
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

/**
 * The device-registry half of `SessionDeps`. Defaults to an empty registry that
 * any target misses (so PTY-only tests never touch the real DB); the device
 * tests pass a `fakeRegistry` with rows + a recording `revoke`.
 */
function emptyRegistry(): Pick<SessionDeps, 'listDevices' | 'revokeDevice' | 'resolveTarget'> {
  return {
    listDevices: (() => []) as SessionDeps['listDevices'],
    resolveTarget: ((target: string) => {
      throw new RegistryError('not_found', `no device matches '${target}'`);
    }) as SessionDeps['resolveTarget'],
    revokeDevice: ((target: string) => {
      throw new RegistryError('not_found', `no device matches '${target}'`);
    }) as SessionDeps['revokeDevice'],
  };
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
    ...emptyRegistry(),
    identity: { deviceId: '' },
  };
  return state;
}

function device(overrides: Partial<AuthDevice> & { id: string }): AuthDevice {
  return {
    label: `label-${overrides.id}`,
    pubkey: `pubkey-${overrides.id}`,
    fingerprint: `fp${overrides.id}`,
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    lastAddress: null,
    ...overrides,
  };
}

/**
 * A registry double over an in-memory device list. `resolveTarget` matches by
 * id, exact label, or fingerprint prefix (mirroring the real one's semantics);
 * `revokeDevice` records the resolved id and removes the row.
 */
function fakeRegistry(devices: AuthDevice[]) {
  const revoked: string[] = [];
  const resolve = (target: string): AuthDevice => {
    const matches = devices.filter(
      (d) => d.id === target || d.label === target || d.fingerprint.startsWith(target),
    );
    if (matches.length === 0) throw new RegistryError('not_found', `no device matches '${target}'`);
    if (matches.length > 1) throw new RegistryError('ambiguous', `multiple match '${target}'`);
    return matches[0];
  };
  const deps: Pick<SessionDeps, 'listDevices' | 'revokeDevice' | 'resolveTarget'> = {
    listDevices: (() => devices) as SessionDeps['listDevices'],
    resolveTarget: resolve as SessionDeps['resolveTarget'],
    revokeDevice: ((target: string) => {
      const d = resolve(target);
      revoked.push(d.id);
      const idx = devices.indexOf(d);
      if (idx >= 0) devices.splice(idx, 1);
      return d;
    }) as SessionDeps['revokeDevice'],
  };
  return { deps, revoked };
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

describe('runNoiseSession — robustness (cipher-desync fixes)', () => {
  test('large output is chunked into multiple sealed frames (each under the FFI buffer)', async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    const big = 'x'.repeat(40 * 1024); // > MAX_OUTPUT_CHARS (16 KiB)
    pty.subscriptions[0].sub({ type: 'output', chunk: big, id: 1 });

    expect(io.sent.length).toBeGreaterThan(1);
    // Reassembling the chunks reproduces the original output exactly.
    const reassembled = io.sent
      .map((f) => JSON.parse(dec.decode(f)) as { t: string; chunk: string })
      .filter((m) => m.t === 'output')
      .map((m) => m.chunk)
      .join('');
    expect(reassembled).toBe(big);
    for (const f of io.sent) expect(f.length).toBeLessThan(512 * 1024);
  });

  test('a seal failure tears the session down instead of desyncing the cipher', async () => {
    const pty = fakePty();
    // A channel whose seal always throws (mimics an FFI seal/send failure).
    const throwing = {
      seal: () => {
        throw new Error('seal boom');
      },
      open: (wire: Uint8Array) => wire,
      free: () => {},
    } as unknown as ServerChannel;

    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    const done = runNoiseSession(throwing, io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    // Driving output triggers a seal failure → fatal → the loop returns.
    pty.subscriptions[0].sub({ type: 'output', chunk: 'boom', id: 1 });
    await expect(done).resolves.toBeUndefined();
    expect(pty.unsubscribed).toBeGreaterThanOrEqual(1); // cleaned up
    expect(io.sent).toHaveLength(0); // nothing sent after the failed seal
  });
});

describe('runNoiseSession — device management', () => {
  test("'devices.list' returns the rows with isSelf on the caller's own device", async () => {
    const pty = fakePty();
    const registry = fakeRegistry([
      device({ id: 'dev-self', label: 'my-phone' }),
      device({ id: 'dev-other', label: 'old-laptop', lastSeenAt: '2026-02-02T00:00:00.000Z' }),
    ]);
    const io = scriptedIo([jsonFrame({ t: 'devices.list' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      ...registry.deps,
      identity: { deviceId: 'dev-self' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(io.sent).toHaveLength(1);
    const reply = JSON.parse(dec.decode(io.sent[0]));
    expect(reply.t).toBe('devices');
    expect(reply.items).toEqual([
      {
        id: 'dev-self',
        label: 'my-phone',
        fingerprint: 'fpdev-self',
        pairedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: null,
        lastAddress: null,
        isSelf: true,
      },
      {
        id: 'dev-other',
        label: 'old-laptop',
        fingerprint: 'fpdev-other',
        pairedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-02-02T00:00:00.000Z',
        lastAddress: null,
        isSelf: false,
      },
    ]);
  });

  test("'devices.revoke' on a good target revokes and replies ok:true", async () => {
    const pty = fakePty();
    const registry = fakeRegistry([
      device({ id: 'dev-self' }),
      device({ id: 'dev-other', label: 'to-remove' }),
    ]);
    const io = scriptedIo([jsonFrame({ t: 'devices.revoke', target: 'to-remove' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      ...registry.deps,
      identity: { deviceId: 'dev-self' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(registry.revoked).toEqual(['dev-other']);
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({
      t: 'devices.revoked',
      target: 'to-remove',
      ok: true,
    });
  });

  test("'devices.revoke' allows self-revoke (CLI parity — not blocked)", async () => {
    const pty = fakePty();
    const registry = fakeRegistry([device({ id: 'dev-self', label: 'my-phone' })]);
    const io = scriptedIo([jsonFrame({ t: 'devices.revoke', target: 'dev-self' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      ...registry.deps,
      identity: { deviceId: 'dev-self' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(registry.revoked).toEqual(['dev-self']);
    expect(JSON.parse(dec.decode(io.sent[0])).ok).toBe(true);
  });

  test("'devices.revoke' on a bad target replies ok:false and keeps the session alive", async () => {
    const pty = fakePty();
    const registry = fakeRegistry([device({ id: 'dev-self' })]);
    const io = scriptedIo([
      jsonFrame({ t: 'devices.revoke', target: 'nope' }),
      // A follow-up start must still be processed — the loop did not tear down.
      jsonFrame({ t: 'start', id: 's-after' }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      ...registry.deps,
      identity: { deviceId: 'dev-self' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(registry.revoked).toEqual([]); // nothing removed
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({
      t: 'devices.revoked',
      target: 'nope',
      ok: false,
      error: 'No device matches that target.',
    });
    // The session survived the bad revoke and went on to start a session.
    expect(pty.starts.map((s) => s.id)).toEqual(['s-after']);
  });

  test("'devices.revoke' on an ambiguous target replies ok:false with a friendly error", async () => {
    const pty = fakePty();
    const registry = fakeRegistry([
      device({ id: 'a1', fingerprint: 'abcd1' }),
      device({ id: 'a2', fingerprint: 'abcd2' }),
    ]);
    const io = scriptedIo([jsonFrame({ t: 'devices.revoke', target: 'abcd' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      ...registry.deps,
      identity: { deviceId: 'a1' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(registry.revoked).toEqual([]);
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({
      t: 'devices.revoked',
      target: 'abcd',
      ok: false,
      error: 'That target matches more than one device.',
    });
  });
});
