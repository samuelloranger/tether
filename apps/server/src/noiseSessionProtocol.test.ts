import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentDriver } from '@/agent/driver';
import { FakeAgentDriver } from '@/agent/driver';
import { getAgentMessages } from '@/agent/messages';
import { AgentRegistry } from '@/agent/registry';
import { type AuthDevice, RegistryError } from '@/auth/deviceRegistry';
import { db } from '@/infra/db';
import { getConfig } from '@/infra/settings';
import type { FocusSubscriber } from '@/pty/registry';
import type { FrameIO, ServerChannel } from './noiseChannel';
import { runNoiseSession, type SessionDeps } from './noiseSessionProtocol';

const enc = new TextEncoder();
const dec = new TextDecoder();

// The agent tests persist prompts to the shared per-process DB and seed the seq
// from its MAX; clear it before each so a sibling test's rows can't shift seqs
// (fails only in the full parallel suite, where files share one DB).
beforeEach(() => {
  db.query('DELETE FROM agent_messages').run();
});

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
  focuses: Array<{ id: string; focused: boolean }>;
  subscriptions: Array<{ id: string; sub: FocusSubscriber }>;
  unsubscribed: number;
  // Sessions already running server-side before this channel's `start` — a
  // switch-back reattach, as opposed to a fresh spawn.
  live: Set<string>;
  kicks: string[];
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
    focuses: [],
    subscriptions: [],
    unsubscribed: 0,
    live: new Set<string>(),
    kicks: [],
    deps: {} as SessionDeps,
  };
  state.deps = {
    startSession: (async (id, command, cols = 80, rows = 24) => {
      state.starts.push({ id, command, cols, rows });
      state.live.add(id); // a started session is now live
      return {} as never;
    }) as SessionDeps['startSession'],
    isSessionLive: ((id: string) => state.live.has(id)) as SessionDeps['isSessionLive'],
    kickPtySize: ((id: string) => {
      state.kicks.push(id);
    }) as SessionDeps['kickPtySize'],
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
    setSessionFocus: ((id, client, focused) => {
      state.focuses.push({ id, focused });
      client.focused = focused;
    }) as SessionDeps['setSessionFocus'],
    getReplayLogs: () => ({ reset: false, logs: [] }),
    getAgentMessages: () => [],
    fetchAgentUsage: async () => null,
    listClaudeSessions: () => [],
    translateClaudeSession: () => [],
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

  // Switch-back over Noise: the PTY is already running, the fit does not move, and
  // Noise does not replay logs — so nothing paints unless we raise one SIGWINCH.
  // Ink/cursor-agent only full-redraw on SIGWINCH; without this the reused emulator
  // shows a frozen frame after the next send.
  test("'start' on an already-running session kicks the PTY (SIGWINCH) so a TUI repaints", async () => {
    const pty = fakePty();
    pty.live.add('s1'); // resident session, kept alive across the tab switch
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1', cols: 100, rows: 40 })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.subscriptions).toHaveLength(1);
    expect(pty.kicks).toEqual(['s1']);
  });

  test("'start' on a fresh session does not kick (the initial draw paints it)", async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.kicks).toEqual([]);
  });

  // Switch-back (and kill-relaunch, long-background) drop the Noise socket.
  // SIGWINCH is a no-op when the TUI is idle, so missed terminal_logs must
  // be replayed. Old clients omit sinceId and keep the SIGWINCH-only path.
  test("'start' with sinceId replays missed logs as sealed output before live subscribe", async () => {
    const pty = fakePty();
    pty.live.add('s1');
    const replayed: Array<{ sessionId: string; sinceId: number }> = [];
    pty.deps.getReplayLogs = (sessionId, sinceId) => {
      replayed.push({ sessionId, sinceId });
      return {
        reset: false,
        logs: [
          { id: 11, chunk: 'LINE_011\n' },
          { id: 12, chunk: 'LINE_012\n' },
        ],
      };
    };
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1', cols: 80, rows: 24, sinceId: 10 })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(replayed).toEqual([{ sessionId: 's1', sinceId: 10 }]);
    const msgs = io.sent.map(
      (f) => JSON.parse(dec.decode(f)) as { t: string; chunk?: string; id?: number },
    );
    expect(msgs.filter((m) => m.t === 'output')).toEqual([
      { t: 'output', chunk: 'LINE_011\nLINE_012\n', id: 12 },
    ]);
    expect(pty.subscriptions).toHaveLength(1);
    expect(pty.kicks).toEqual(['s1']);
  });

  test("'start' without sinceId does not replay (old clients)", async () => {
    const pty = fakePty();
    pty.live.add('s1');
    let called = 0;
    pty.deps.getReplayLogs = () => {
      called += 1;
      return { reset: false, logs: [{ id: 1, chunk: 'secret\n' }] };
    };
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(called).toBe(0);
    expect(io.sent).toHaveLength(0);
    expect(pty.kicks).toEqual(['s1']);
  });

  test("'start' sends reset before replay when the catch-up was trimmed", async () => {
    const pty = fakePty();
    pty.deps.getReplayLogs = () => ({
      reset: true,
      logs: [{ id: 99, chunk: 'TAIL\n' }],
    });
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1', sinceId: 0 })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent.map(
      (f) => JSON.parse(dec.decode(f)) as { t: string; id?: string | number; chunk?: string },
    );
    expect(msgs.map((m) => m.t)).toEqual(['reset', 'output']);
    expect(msgs[0]).toEqual({ t: 'reset', id: 's1' });
    expect(msgs[1]).toEqual({ t: 'output', chunk: 'TAIL\n', id: 99 });
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

  test('subscriber starts unfocused', async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'start', id: 's1' })]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    expect(pty.subscriptions[0].sub.focused).toBe(false);
  });

  test('subscriber starts unfocused; focus true then false is per-id', async () => {
    const pty = fakePty();
    const io = scriptedIo([
      jsonFrame({ t: 'start', id: 's1' }),
      jsonFrame({ t: 'start', id: 's2' }),
      jsonFrame({ t: 'focus', id: 's1', focused: true }),
    ]);
    void runNoiseSession(identityChannel(), io, pty.deps);
    await new Promise((r) => setTimeout(r, 5));

    const s1 = pty.subscriptions.find((s) => s.id === 's1')!.sub;
    const s2 = pty.subscriptions.find((s) => s.id === 's2')!.sub;
    expect(s1.focused).toBe(true);
    expect(s2.focused).toBe(false);
    expect(pty.focuses).toEqual([{ id: 's1', focused: true }]);

    io.deliver(jsonFrame({ t: 'focus', id: 's1', focused: false }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s1.focused).toBe(false);

    io.deliver(jsonFrame({ t: 'focus', id: 'nope', focused: true }));
    io.deliver(jsonFrame({ t: 'focus', id: 's1' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s1.focused).toBe(false);
    expect(pty.focuses).toEqual([
      { id: 's1', focused: true },
      { id: 's1', focused: false },
    ]);
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

  test("'auth.token' seals back the injected mint for the session device", async () => {
    const pty = fakePty();
    const minted = { token: 'tok-from-inject', expiresAt: '2026-09-05T00:00:00.000Z' };
    const mintedFor: string[] = [];
    const io = scriptedIo([jsonFrame({ t: 'auth.token' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      identity: { deviceId: 'dev-self' },
      mintToken: (deviceId) => {
        mintedFor.push(deviceId);
        return minted;
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(mintedFor).toEqual(['dev-self']);
    expect(JSON.parse(dec.decode(io.sent[0]))).toEqual({
      t: 'auth.token',
      token: 'tok-from-inject',
      expiresAt: '2026-09-05T00:00:00.000Z',
    });
  });
});

describe('runNoiseSession — agent chat', () => {
  test("'agent.start' then 'agent.prompt' streams the driver's frames back sealed", async () => {
    const pty = fakePty();
    const io = scriptedIo([
      jsonFrame({ t: 'agent.start', id: 'a1', cwd: '/tmp' }),
      jsonFrame({ t: 'agent.prompt', text: 'hello' }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(
        () =>
          new FakeAgentDriver([
            [
              { t: 'delta', text: 'Hi' },
              { t: 'done', cost: 0, usage: {} },
            ],
          ]),
      ),
    });
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent
      .map((f) => JSON.parse(dec.decode(f)))
      .filter((m) => m.t !== 'agent.status');
    expect(msgs).toEqual([
      { t: 'agent.user', seq: 1, text: 'hello' },
      { t: 'agent.delta', seq: 2, text: 'Hi' },
      { t: 'agent.done', seq: 3, cost: 0, usage: {} },
    ]);
  });

  test("'agent.list-sessions' replies with agent.sessions", async () => {
    const pty = fakePty();
    const io = scriptedIo([jsonFrame({ t: 'agent.list-sessions', cwd: '/work/repo' })]);
    const sessions = [{ id: 's1', label: 'x', mtimeMs: 1, msgCount: 2, cwd: '/work/repo' }];
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      listClaudeSessions: () => sessions,
    });
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent.map((f) => JSON.parse(dec.decode(f)));
    expect(msgs).toContainEqual({ t: 'agent.sessions', sessions });
  });

  test("resume 'agent.start' persists translated history before the first prompt", async () => {
    const pty = fakePty();
    const seeded: string[] = [];
    class ResumeDriver extends FakeAgentDriver {
      seedResume(s: string) {
        seeded.push(s);
      }
    }
    const io = scriptedIo([
      jsonFrame({
        t: 'agent.start',
        id: 'a-resume',
        cwd: '/tmp',
        resumeClaudeSessionId: 'claude-1',
      }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(() => new ResumeDriver([])),
      getAgentMessages: (id, since) => getAgentMessages(db, id, since),
      translateClaudeSession: () => [
        { kind: 'user', text: 'old-a' },
        { kind: 'delta', text: 'old-b' },
      ],
    });
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent
      .map((f) => JSON.parse(dec.decode(f)))
      .filter((m) => m.t !== 'agent.status');
    expect(msgs).toEqual([
      { t: 'agent.user', seq: 1, text: 'old-a' },
      { t: 'agent.delta', seq: 2, text: 'old-b' },
    ]);
    expect(seeded).toEqual(['claude-1']);
  });

  test("'agent.model' sets the driver model, persists the default, re-emits status", async () => {
    const pty = fakePty();
    class ModelDriver extends FakeAgentDriver {
      private m: string | null = null;
      setModel(n: string | null) {
        this.m = n;
      }
      getModel(): string | null {
        return this.m;
      }
    }
    const io = scriptedIo([
      jsonFrame({ t: 'agent.start', id: 'a-model', cwd: '/tmp' }),
      jsonFrame({ t: 'agent.model', name: 'opus' }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(() => new ModelDriver([])),
    });
    await new Promise((r) => setTimeout(r, 5));

    const statuses = io.sent
      .map((f) => JSON.parse(dec.decode(f)))
      .filter((m) => m.t === 'agent.status');
    expect(statuses.at(-1)?.model).toBe('opus');
    expect(getConfig().agent.defaultModel).toBe('opus');
  });

  test("'agent.start' whose driver fails to start is caught, not an unhandled rejection, and tells the client", async () => {
    const pty = fakePty();
    class BrokenStartDriver implements AgentDriver {
      async start(_cwd: string): Promise<void> {
        throw new Error('driver start blew up');
      }
      prompt(_text: string): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('unused')) }),
        };
      }
      interrupt(): void {}
      close(): void {}
    }
    const io = scriptedIo([jsonFrame({ t: 'agent.start', id: 'a-broken-start', cwd: '/tmp' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(() => new BrokenStartDriver()),
    }); // never throws out of the loop
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent.map((f) => JSON.parse(dec.decode(f)));
    expect(msgs).toEqual([{ t: 'agent.error', message: 'agent start failed' }]);
  });

  test("'agent.prompt' rejecting mid-stream is caught, not an unhandled rejection", async () => {
    const pty = fakePty();
    // A driver whose prompt() throws before yielding anything — stands in for a
    // driver crash mid-stream.
    class ThrowingDriver implements AgentDriver {
      async start(_cwd: string): Promise<void> {}
      prompt(_text: string): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('driver blew up')),
          }),
        };
      }
      interrupt(): void {}
      close(): void {}
    }
    const io = scriptedIo([
      jsonFrame({ t: 'agent.start', id: 'a-throw', cwd: '/tmp' }),
      jsonFrame({ t: 'agent.prompt', text: 'hello' }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(() => new ThrowingDriver()),
    });
    await new Promise((r) => setTimeout(r, 5));

    const msgs = io.sent
      .map((f) => JSON.parse(dec.decode(f)))
      .filter((m) => m.t !== 'agent.status');
    expect(msgs).toEqual([
      { t: 'agent.user', seq: 1, text: 'hello' },
      { t: 'agent.error', message: 'agent prompt failed' },
    ]);
  });

  test('a disconnect detaches but does not kill the agent — a later reconnect re-attaches', async () => {
    const pty = fakePty();
    const driver = new FakeAgentDriver([[{ t: 'delta', text: 'Hi' }]]);
    const registry = new AgentRegistry(() => driver);

    // Connection 1: agent.start, then the socket closes (io.recv rejects) —
    // mirrors the app-close path that used to call registry.killAll().
    const frames1 = [jsonFrame({ t: 'agent.start', id: 'a-survives', cwd: '/tmp' })];
    const pendingRecv1: { reject: ((e: Error) => void) | null } = { reject: null };
    const io1: FrameIO = {
      send: () => {},
      recv: () => {
        const next = frames1.shift();
        if (next) return Promise.resolve(next);
        return new Promise<Uint8Array>((_res, rej) => {
          pendingRecv1.reject = rej;
        });
      },
    };
    const done1 = runNoiseSession(identityChannel(), io1, { ...pty.deps, agentRegistry: registry });
    await new Promise((r) => setTimeout(r, 5));
    expect(driver.startCount).toBe(1);
    expect(registry.has('a-survives')).toBe(true);

    pendingRecv1.reject?.(new Error('socket closed'));
    await done1;

    // The disconnect must NOT have killed the driver.
    expect(driver.closed).toBe(false);
    expect(registry.has('a-survives')).toBe(true);

    // Connection 2: a fresh client reconnects and re-opens the same agent id.
    const io2 = scriptedIo([jsonFrame({ t: 'agent.start', id: 'a-survives', cwd: '/tmp' })]);
    void runNoiseSession(identityChannel(), io2, { ...pty.deps, agentRegistry: registry });
    await new Promise((r) => setTimeout(r, 5));

    // Re-attach only — no second spawn.
    expect(driver.startCount).toBe(1);
  });

  test("'agent.start' with sinceSeq replays stored frames to this client before live frames resume", async () => {
    const pty = fakePty();
    const replayed: Array<{ sessionId: string; sinceSeq: number }> = [];
    pty.deps.getAgentMessages = (sessionId, sinceSeq) => {
      replayed.push({ sessionId, sinceSeq });
      return [
        {
          session_id: sessionId,
          seq: 3,
          kind: 'delta',
          text: 'earlier reply',
          tool_json: null,
          is_error: 0,
          ts: 0,
        },
        {
          session_id: sessionId,
          seq: 4,
          kind: 'done',
          text: null,
          tool_json: JSON.stringify({ cost: 0.01, usage: {} }),
          is_error: 0,
          ts: 0,
        },
      ];
    };
    const io = scriptedIo([
      jsonFrame({ t: 'agent.start', id: 'a-replay', cwd: '/tmp', sinceSeq: 2 }),
      jsonFrame({ t: 'agent.prompt', text: 'more' }),
    ]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(
        () => new FakeAgentDriver([[{ t: 'delta', text: 'live chunk' }]]),
        () => {}, // don't touch the real DB in this test
      ),
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(replayed).toEqual([{ sessionId: 'a-replay', sinceSeq: 2 }]);
    const msgs = io.sent
      .map((f) => JSON.parse(dec.decode(f)))
      .filter((m) => m.t !== 'agent.status');
    // Replayed frames (reconstructed from the stored rows) precede the live turn,
    // which now opens with the echoed user prompt before the assistant delta.
    expect(msgs).toEqual([
      { t: 'agent.delta', seq: 3, text: 'earlier reply' },
      { t: 'agent.done', seq: 4, cost: 0.01, usage: {} },
      { t: 'agent.user', seq: 1, text: 'more' },
      { t: 'agent.delta', seq: 2, text: 'live chunk' },
    ]);
  });

  test("'agent.start' without sinceSeq defaults to 0 (full-transcript replay for a cold client)", async () => {
    const pty = fakePty();
    const replayed: Array<{ sessionId: string; sinceSeq: number }> = [];
    pty.deps.getAgentMessages = (sessionId, sinceSeq) => {
      replayed.push({ sessionId, sinceSeq });
      return [];
    };
    const io = scriptedIo([jsonFrame({ t: 'agent.start', id: 'a-cold', cwd: '/tmp' })]);
    void runNoiseSession(identityChannel(), io, {
      ...pty.deps,
      agentRegistry: new AgentRegistry(
        () => new FakeAgentDriver([]),
        () => {},
      ),
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(replayed).toEqual([{ sessionId: 'a-cold', sinceSeq: 0 }]);
  });
});
