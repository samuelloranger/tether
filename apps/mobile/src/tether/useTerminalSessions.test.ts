import { describe, expect, test } from 'bun:test';
import type { DrawerSession } from '../SessionDrawer';
import type { SessionEntry } from '../sessionCache';
import {
  applyWsMessage,
  backoffDelay,
  createSessionCache,
  focusFrame,
  maybeNotify,
  parseSessionKey,
  runIfCurrentGeneration,
  scheduleReconnect,
  sessionKey,
  sessionSwitchAction,
  statusAfterClose,
} from './terminalSessionLogic';

function entry(): SessionEntry & { writes: string[]; resets: number } {
  const result = {
    writes: [] as string[],
    resets: 0,
    term: {
      bellCount: 0,
      notifyCount: 0,
      lastNotify: { title: '', body: '' },
      promptReturnCount: 0,
      title: '',
      cwd: '',
      write(data: string, done?: () => void) {
        result.writes.push(data);
        done?.();
      },
      reset() {
        result.resets++;
      },
    },
    sinceId: 0,
    lastAppliedId: 0,
    diffSummary: { files: [] },
    lastBellCount: 0,
    lastNotifyCount: 0,
  };
  return result as unknown as SessionEntry & { writes: string[]; resets: number };
}

function dispatch(entryForMessage = entry(), activeId = 'term-1') {
  let rows: DrawerSession[] = [
    { hostId: 'host-1', id: 'term-1', status: 'running', last_output_at: null },
  ];
  const effects = {
    git: 0,
    metadata: 0,
    hydrated: 0,
    notifications: 0,
    waiting: [] as DrawerSession[][],
    output: [] as string[],
  };
  const apply = (message: unknown) =>
    applyWsMessage({
      id: 'term-1',
      drawerHostId: 'host-1',
      message,
      entry: entryForMessage,
      activeId,
      onGitSummaryChanged: () => effects.git++,
      onTerminalMetadataChanged: () => effects.metadata++,
      onDrawerSessions: (update) => {
        rows = update(rows);
      },
      onWaitingSessions: (sessions) => effects.waiting.push(sessions),
      onOutput: (_id, chunk) => effects.output.push(chunk),
      onNotify: () => effects.notifications++,
      hydrateRenderer: () => effects.hydrated++,
    });
  return { apply, effects, entry: entryForMessage, rows: () => rows };
}

describe('backoffDelay', () => {
  test('grows monotonically through the capped retry window', () => {
    const delays = Array.from({ length: 10 }, (_, attempt) => backoffDelay(attempt, () => 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000]);
  });

  test('keeps random jitter in the upper half of each capped delay band', () => {
    expect(backoffDelay(5, () => 0)).toBe(15000);
    expect(backoffDelay(5, () => 0.999999)).toBe(29999);
    expect(backoffDelay(99, () => 0.999999)).toBe(29999);
  });
});

test('a superseded generation cannot apply a message or schedule a reconnect', () => {
  const state = { gen: 2 };
  let messages = 0;
  let closes = 0;
  expect(runIfCurrentGeneration(state, 1, () => messages++)).toBe(false);
  expect(runIfCurrentGeneration(state, 1, () => closes++)).toBe(false);
  expect(messages).toBe(0);
  expect(closes).toBe(0);
  expect(runIfCurrentGeneration(state, 2, () => messages++)).toBe(true);
  expect(messages).toBe(1);
});

test('a scheduled reconnect reads the HostClient that is current when it fires', () => {
  const readyRef = { current: true };
  const clientRef = { current: { socketUrl: 'ws://192.168.1.8:8085/api/ws' } };
  let scheduled: (() => void) | undefined;
  const targets: string[] = [];
  scheduleReconnect({
    id: 'term-1',
    readyRef,
    delay: 1000,
    schedule: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    reconnect: () =>
      targets.push(
        `${clientRef.current.socketUrl}?${new URLSearchParams({
          sessionId: 'term-1',
          sinceId: '4',
          cols: '80',
          rows: '24',
        })}`,
      ),
  });
  clientRef.current = { socketUrl: 'ws://10.0.0.9:9090/api/ws' };
  scheduled?.();
  expect(targets).toEqual(['ws://10.0.0.9:9090/api/ws?sessionId=term-1&sinceId=4&cols=80&rows=24']);
});

describe('host-qualified session state', () => {
  test('keeps same-named sessions on two hosts distinct', () => {
    const studio = sessionKey('studio', 'term-1');
    const laptop = sessionKey('laptop', 'term-1');
    expect(studio).toBe('studio:term-1');
    expect(laptop).toBe('laptop:term-1');
    expect(studio).not.toBe(laptop);
    expect(parseSessionKey(laptop)).toEqual({ hostId: 'laptop', sessionId: 'term-1' });
  });

  test('evicts and disconnects the least-recent session across hosts at the global cap', () => {
    const disconnected: string[] = [];
    const cache = createSessionCache((id) => disconnected.push(id));
    for (const [hostId, sessionId] of [
      ['studio', 'term-1'],
      ['laptop', 'term-1'],
      ['studio', 'term-2'],
      ['laptop', 'term-2'],
    ])
      cache.touch(sessionKey(hostId, sessionId), entry);
    expect(disconnected).toEqual(['studio:term-1']);
    expect(cache.has('laptop:term-1')).toBe(true);
  });

  test('switching hosts hydrates a resident emulator without reconnecting it', () => {
    expect(sessionSwitchAction('studio:term-1', 'laptop:term-1', true)).toBe('hydrate');
  });

  test('a background session close leaves the active connection status unchanged', () => {
    expect(statusAfterClose('studio:term-1', 'laptop:term-1', 'connected')).toBe('connected');
    expect(statusAfterClose('studio:term-1', 'studio:term-1', 'connected')).toBe('disconnected');
  });

  test('focus frames reflect mount, background, and foreground for the active session only', () => {
    expect([focusFrame(true), focusFrame(false), focusFrame(true)]).toEqual([
      { type: 'focus', focused: true },
      { type: 'focus', focused: false },
      { type: 'focus', focused: true },
    ]);
  });
});

describe('applyWsMessage', () => {
  test('applies new output once and drops a replayed output id', () => {
    const harness = dispatch();
    harness.apply({ type: 'output', id: 4, chunk: 'hello' });
    harness.apply({ type: 'output', id: 4, chunk: 'again' });
    expect(harness.entry.lastAppliedId).toBe(4);
    expect(harness.entry.sinceId).toBe(4);
    expect(harness.effects.output).toEqual(['hello']);
  });

  test('updates the active diff summary', () => {
    const harness = dispatch();
    harness.apply({ type: 'diff', summary: { files: [{ path: 'src/app.ts' }] } });
    expect(harness.entry.diffSummary).toEqual({ files: [{ path: 'src/app.ts' }] });
    expect(harness.effects.git).toBe(1);
  });

  test('writes an exit marker', () => {
    const harness = dispatch();
    harness.apply({ type: 'exit', exitCode: 17 });
    expect(harness.entry.writes).toEqual(['\r\n\x1b[31m[Process exited with code 17]\x1b[0m\r\n']);
  });

  test('updates a title message in the drawer row', () => {
    const harness = dispatch();
    harness.apply({ type: 'title', title: 'build' });
    expect(harness.rows()[0]?.auto_title).toBe('build');
  });

  test('updates activity and announces the changed row', () => {
    const harness = dispatch();
    harness.apply({ type: 'activity', activity: 'waiting' });
    expect(harness.rows()[0]?.activity).toBe('waiting');
    expect(harness.effects.waiting).toEqual([
      [
        {
          hostId: 'host-1',
          id: 'term-1',
          status: 'running',
          last_output_at: null,
          activity: 'waiting',
        },
      ],
    ]);
  });

  test('resets replay and notification cursors and repaints the active terminal', () => {
    const session = entry();
    session.sinceId = 9;
    session.lastAppliedId = 9;
    session.lastBellCount = 3;
    session.lastNotifyCount = 2;
    const harness = dispatch(session);
    harness.apply({ type: 'reset' });
    expect(session.resets).toBe(1);
    expect([
      session.sinceId,
      session.lastAppliedId,
      session.lastBellCount,
      session.lastNotifyCount,
    ]).toEqual([0, 0, 0, 0]);
    expect(harness.effects.hydrated).toBe(1);
  });
});

describe('maybeNotify', () => {
  test('suppresses an edge for an active focused session but consumes it', () => {
    const session = entry();
    session.term.notifyCount = 1;
    session.term.lastNotify = { title: 'Done', body: 'Build finished' };
    const notifications: string[][] = [];
    maybeNotify({
      id: 'term-1',
      entry: session,
      activeId: 'term-1',
      windowFocused: true,
      notificationsEnabled: true,
      isDesktop: true,
      notify: (title, body) => notifications.push([title, body]),
    });
    maybeNotify({
      id: 'term-1',
      entry: session,
      activeId: 'term-2',
      windowFocused: false,
      notificationsEnabled: true,
      isDesktop: true,
      notify: (title, body) => notifications.push([title, body]),
    });
    expect(notifications).toEqual([]);
    expect(session.lastNotifyCount).toBe(1);
  });

  test('fires once for each new notify and bell edge', () => {
    const session = entry();
    const notifications: string[][] = [];
    const options = {
      id: 'term-2',
      entry: session,
      activeId: 'term-1',
      windowFocused: true,
      notificationsEnabled: true,
      isDesktop: true,
      label: 'Build',
      notify: (title: string, body: string) => notifications.push([title, body]),
    };
    session.term.notifyCount = 1;
    session.term.lastNotify = { title: 'Done', body: 'Build finished' };
    maybeNotify(options);
    maybeNotify(options);
    session.term.bellCount = 1;
    maybeNotify(options);
    maybeNotify(options);
    expect(notifications).toEqual([
      ['Done', 'Build finished'],
      ['Build', 'Terminal bell'],
    ]);
    expect([session.lastNotifyCount, session.lastBellCount]).toEqual([1, 1]);
  });
});

test('evicting a terminal from the session cache disconnects it', () => {
  const disconnected: string[] = [];
  const cache = createSessionCache((id) => disconnected.push(id));
  for (const id of ['term-1', 'term-2', 'term-3', 'term-4']) cache.touch(id, entry);
  expect(disconnected).toEqual(['term-1']);
});
