import { type Context, Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { getSession, listSessions, renameSession } from '../db';
import { trackDeviceChannel } from '../deviceChannels';
import { getLiveCwd } from '../liveCwd';
import { logError, logInfo, logWarn } from '../log';
import {
  type FocusSubscriber,
  getActiveSession,
  killSession,
  resizeSession,
  setSessionFocus,
  startSession,
  subscribeToSession,
  writeToSession,
} from '../pty';
import { REPLAY_BYTE_BUDGET, replayOutputFrames } from '../replayPlan';
import { getReplayLogs } from '../replayRead';
import { getActivity } from '../sessionActivity';
import { autoTitle, getOscTitle } from '../sessionTitle';
import { codecFor, type TerminalCodec, type WireData } from './terminalCodec';

export const sessionsRoutes = new Hono();

type WsSink = {
  send: (data: WireData) => void;
  close: () => void;
  raw?: { getBufferedAmount?: () => number };
};

type WsSessionState = {
  unsubscribe: () => void;
  closed: boolean;
  onData: FocusSubscriber;
  keepAlive: ReturnType<typeof setInterval> | null;
};

function ptySubscriber(ws: WsSink, codec: TerminalCodec, sessionId: string): FocusSubscriber {
  const onData: FocusSubscriber = (data) => {
    // ponytail: no queueing for slow clients — if the socket's send
    // buffer blows past 4MB, close it; reconnect replays from the cursor.
    const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
    const buffered = raw?.getBufferedAmount?.();
    if (buffered !== undefined && buffered > 4_000_000) {
      logWarn(
        `WebSocket backpressure: closing session "${sessionId}" (bufferedAmount=${buffered})`,
      );
      try {
        ws.close();
      } catch {}
      return;
    }
    try {
      if (data.type === 'output') {
        ws.send(codec.liveOutput(data.chunk, data.id));
      } else if (data.type === 'exit') {
        ws.send(codec.exit(data.exitCode));
      } else if (data.type === 'diff') {
        ws.send(codec.diff(data.summary, data.status));
      } else if (data.type === 'activity') {
        ws.send(codec.activity(data.activity));
      } else if (data.type === 'title') {
        const frame = codec.title(data.title);
        if (frame !== null) ws.send(frame);
      }
    } catch (wsErr) {
      logWarn('WebSocket send error during PTY broadcast:', wsErr);
    }
  };
  onData.focused = true;
  return onData;
}

async function hydrateTerminalSocket(
  ws: WsSink,
  sessionId: string,
  sinceId: number,
  cols: number,
  rows: number,
  state: WsSessionState,
  codec: TerminalCodec,
): Promise<void> {
  try {
    // Auto-start or reattach the PTY. Everything after this await runs
    // synchronously, so no frame slips between the replay read and subscribe.
    await startSession(sessionId, undefined, cols, rows);

    // Bound catch-up by bytes: a row-capped scrollback is not a size cap (one
    // TUI repaint can be >100 KB), and an unbounded replay kills the client.
    const plan = getReplayLogs(sessionId, sinceId, REPLAY_BYTE_BUDGET);
    const missedLogs = plan.logs;

    // Either a prune or a trimmed replay leaves a hole in the client's
    // history — tell it to wipe its emulator before the replay.
    const sess = getSession(sessionId);
    const pruned = sinceId > 0 && sess !== null && sinceId < sess.pruned_before;
    if (pruned || plan.reset) {
      ws.send(codec.reset());
    }

    logInfo(
      `Streaming ${missedLogs.length} missed logs (${plan.bytes} bytes) to client...` +
        (plan.reset ? ' [trimmed to byte budget, sent reset]' : ''),
    );
    for (const frame of replayOutputFrames(missedLogs)) {
      try {
        ws.send(codec.replayOutput(frame));
      } catch (sendErr) {
        logError(`Failed to send replay through log ${frame.id} to client:`, sendErr);
        return;
      }
    }

    // Client disconnected during the awaits above: onClose already ran, so a
    // late subscribe here would never be cleaned up.
    if (state.closed) return;
    state.unsubscribe = subscribeToSession(sessionId, state.onData, cols, rows);
    // Session exited during the awaits: subscribe returned the no-op and no exit
    // will arrive — tell the client now so it doesn't render a dead terminal.
    if (!getActiveSession(sessionId)) {
      ws.send(codec.exit());
    }
  } catch (err) {
    logError('Error inside settled WebSocket init:', err);
  }
}

function openTerminalSocket(
  ws: WsSink,
  sessionId: string,
  sinceId: number,
  cols: number,
  rows: number,
  state: WsSessionState,
  codec: TerminalCodec,
): void {
  logInfo(`WebSocket opened for session "${sessionId}" since log ID: ${sinceId}`);
  // 20s < the client's 30s watchdog, so a quiet session never trips it.
  state.keepAlive = setInterval(() => {
    try {
      ws.send(codec.ping());
    } catch {}
  }, 20_000);
  state.onData = ptySubscriber(ws, codec, sessionId);
  // Yield execution to let Hono/Bun complete the protocol upgrade before writing
  setTimeout(() => {
    void hydrateTerminalSocket(ws, sessionId, sinceId, cols, rows, state, codec);
  }, 30);
}

function handleTerminalWsMessage(
  event: { data: unknown },
  sessionId: string,
  onData: FocusSubscriber,
  codec: TerminalCodec,
): void {
  try {
    for (const msg of codec.decode(event.data)) {
      if (msg.type === 'input') {
        writeToSession(sessionId, msg.text);
      } else if (msg.type === 'resize') {
        resizeSession(sessionId, onData, msg.cols, msg.rows);
      } else if (msg.type === 'focus') {
        setSessionFocus(sessionId, onData, msg.focused);
      }
    }
  } catch (e) {
    logError('Failed to handle incoming WebSocket message:', e);
  }
}

function createTerminalWsHandlers(c: Context) {
  const sessionId = c.req.query('sessionId') || 'default';
  const deviceId = c.get('deviceId');
  const codec = codecFor(c.req.query('proto') ?? null, sessionId);
  const sinceId = codec.replayFrom(
    { sinceId: c.req.query('sinceId') ?? null, cursor: c.req.query('cursor') ?? null },
    sessionId,
  );
  const cols = Number(c.req.query('cols') || 80);
  const rows = Number(c.req.query('rows') || 24);
  const state: WsSessionState = {
    unsubscribe: () => {},
    closed: false,
    onData: () => {},
    keepAlive: null,
  };
  let untrack: (() => void) | undefined;
  return {
    onOpen(_event: unknown, ws: WsSink) {
      if (deviceId) {
        untrack = trackDeviceChannel(deviceId, () => {
          if (!state.closed) {
            state.closed = true;
            if (state.keepAlive) clearInterval(state.keepAlive);
            state.unsubscribe();
          }
          try {
            ws.close();
          } catch {}
        });
      }
      openTerminalSocket(ws, sessionId, sinceId, cols, rows, state, codec);
    },
    onMessage(event: { data: unknown }, _ws: unknown) {
      handleTerminalWsMessage(event, sessionId, state.onData, codec);
    },
    onClose() {
      logInfo(`WebSocket closed for session "${sessionId}"`);
      state.closed = true;
      if (state.keepAlive) clearInterval(state.keepAlive);
      state.unsubscribe();
      untrack?.();
    },
  };
}

// Sessions from DB, annotated with live activity (null when the server hasn't
// seen output yet — e.g. a detached holder after a server restart).
sessionsRoutes.get('/api/sessions', (c) => {
  return c.json(
    listSessions().map((s) => ({
      ...s,
      activity: s.status === 'running' ? getActivity(s.id) : null,
      auto_title:
        s.status === 'running'
          ? autoTitle(getOscTitle(s.id), getLiveCwd(s.id), s.command)
          : s.command,
    })),
  );
});

sessionsRoutes.post('/api/sessions/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.id || 'default';
  const command = typeof body.command === 'string' ? body.command : undefined;
  const cols = Number(body.cols || 80);
  const rows = Number(body.rows || 24);

  await startSession(sessionId, command, cols, rows);
  const session = getSession(sessionId);
  return c.json({ ok: true, session });
});

sessionsRoutes.post('/api/sessions/kill', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.id || 'default';

  const killed = killSession(sessionId);
  return c.json({ ok: killed });
});

sessionsRoutes.post('/api/sessions/rename', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return c.json({ ok: false, error: 'missing id' }, 400);
  const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
  renameSession(id, trimmed.length ? trimmed : null);
  return c.json({ ok: true });
});

sessionsRoutes.get('/api/sessions/:id/logs', (c) => {
  const sessionId = c.req.param('id');
  const sinceId = Number(c.req.query('sinceId') || 0);

  // Same byte budget as the WebSocket catch-up: an unbounded read here can
  // materialize the whole retained scrollback into one JSON response.
  return c.json(getReplayLogs(sessionId, sinceId, REPLAY_BYTE_BUDGET).logs);
});

sessionsRoutes.get(
  '/api/ws',
  upgradeWebSocket((c) => createTerminalWsHandlers(c)),
);
