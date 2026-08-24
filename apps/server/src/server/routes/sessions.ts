import { type Context, Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { getLogs, getReplayLogs, getSession, listSessions, renameSession } from '../db';
import { getLiveCwd } from '../liveCwd';
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
import { getActivity } from '../sessionActivity';
import { autoTitle, getOscTitle } from '../sessionTitle';

export const sessionsRoutes = new Hono();

type WsSink = {
  send: (data: string) => void;
  close: () => void;
  raw?: { getBufferedAmount?: () => number };
};

type WsSessionState = {
  unsubscribe: () => void;
  closed: boolean;
  onData: FocusSubscriber;
  keepAlive: ReturnType<typeof setInterval> | null;
};

function ptySubscriber(ws: WsSink): FocusSubscriber {
  const onData: FocusSubscriber = (data) => {
    // ponytail: no queueing for slow clients — if the socket's send
    // buffer blows past 4MB, close it; reconnect replays via sinceId.
    const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
    if (raw?.getBufferedAmount && raw.getBufferedAmount() > 4_000_000) {
      try {
        ws.close();
      } catch {}
      return;
    }
    try {
      if (data.type === 'output') {
        ws.send(JSON.stringify({ type: 'output', chunk: data.chunk, id: data.id }));
      } else if (data.type === 'exit') {
        ws.send(JSON.stringify({ type: 'exit', exitCode: data.exitCode }));
      } else if (data.type === 'diff') {
        ws.send(JSON.stringify({ type: 'diff', summary: data.summary, status: data.status }));
      } else if (data.type === 'activity') {
        ws.send(JSON.stringify({ type: 'activity', activity: data.activity }));
      }
    } catch (wsErr) {
      console.warn('WebSocket send error during PTY broadcast:', wsErr);
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
): Promise<void> {
  try {
    // Ensure the PTY process is active (auto-start or holder reattach).
    // Everything after this await runs synchronously, so no PTY frame can
    // slip in between the replay read and the subscribe below.
    await startSession(sessionId, undefined, cols, rows);

    // Bound the catch-up by bytes. A row-capped scrollback is not a size cap
    // (one TUI repaint frame can be >100 KB), and an unbounded replay kills
    // the client mid-stream — it reconnects with a barely advanced sinceId
    // and the next replay is bigger still.
    const plan = getReplayLogs(sessionId, sinceId, REPLAY_BYTE_BUDGET);
    const missedLogs = plan.logs;

    // Either a prune or a trimmed replay leaves a hole in the client's
    // history — tell it to wipe its emulator before the replay.
    const sess = getSession(sessionId);
    const pruned = sinceId > 0 && sess !== null && sinceId < sess.pruned_before;
    if (pruned || plan.reset) {
      ws.send(JSON.stringify({ type: 'reset' }));
    }

    console.log(
      `Streaming ${missedLogs.length} missed logs (${plan.bytes} bytes) to client...` +
        (plan.reset ? ' [trimmed to byte budget, sent reset]' : ''),
    );
    for (const frame of replayOutputFrames(missedLogs)) {
      try {
        ws.send(JSON.stringify(frame));
      } catch (sendErr) {
        console.error(`Failed to send replay through log ${frame.id} to client:`, sendErr);
        return;
      }
    }

    // Skip if the client already disconnected during the awaits above —
    // onClose already ran (unsubscribe was still the no-op), so a late
    // subscribe here would never get cleaned up.
    if (state.closed) return;
    state.unsubscribe = subscribeToSession(sessionId, state.onData, cols, rows);
    // If the session exited during the awaits above, subscribe returned
    // the no-op and no exit will ever arrive — tell the client now so it
    // doesn't render a dead terminal as live.
    if (!getActiveSession(sessionId)) {
      ws.send(JSON.stringify({ type: 'exit' }));
    }
  } catch (err) {
    console.error('Error inside settled WebSocket init:', err);
  }
}

function openTerminalSocket(
  ws: WsSink,
  sessionId: string,
  sinceId: number,
  cols: number,
  rows: number,
  state: WsSessionState,
): void {
  console.log(`WebSocket opened for session "${sessionId}" since log ID: ${sinceId}`);
  // 20s < the client's 30s watchdog, so a quiet session never trips it.
  state.keepAlive = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {}
  }, 20_000);
  state.onData = ptySubscriber(ws);
  // Yield execution to let Hono/Bun complete the protocol upgrade before writing
  setTimeout(() => {
    void hydrateTerminalSocket(ws, sessionId, sinceId, cols, rows, state);
  }, 30);
}

function handleTerminalWsMessage(
  event: { data: unknown },
  sessionId: string,
  onData: FocusSubscriber,
): void {
  try {
    const msg = JSON.parse(event.data as string);
    if (msg.type === 'input' && typeof msg.text === 'string') {
      writeToSession(sessionId, msg.text);
    } else if (msg.type === 'resize') {
      resizeSession(sessionId, onData, Number(msg.cols), Number(msg.rows));
    } else if (msg.type === 'focus' && typeof msg.focused === 'boolean') {
      onData.focused = msg.focused;
      setSessionFocus(sessionId, onData, msg.focused);
    }
  } catch (e) {
    console.error('Failed to handle incoming WebSocket message:', e);
  }
}

function createTerminalWsHandlers(c: Context) {
  const sessionId = c.req.query('sessionId') || 'default';
  const sinceId = Number(c.req.query('sinceId') || 0);
  const cols = Number(c.req.query('cols') || 80);
  const rows = Number(c.req.query('rows') || 24);
  const state: WsSessionState = {
    unsubscribe: () => {},
    closed: false,
    onData: () => {},
    keepAlive: null,
  };
  return {
    onOpen(_event: unknown, ws: WsSink) {
      openTerminalSocket(ws, sessionId, sinceId, cols, rows, state);
    },
    onMessage(event: { data: unknown }, _ws: unknown) {
      handleTerminalWsMessage(event, sessionId, state.onData);
    },
    onClose() {
      console.log(`WebSocket closed for session "${sessionId}"`);
      state.closed = true;
      if (state.keepAlive) clearInterval(state.keepAlive);
      state.unsubscribe();
    },
  };
}

// List all sessions (active or stopped) from DB, annotated with the live
// activity classification (null when the server hasn't seen output yet —
// e.g. a detached holder after a server restart).
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

  const logs = getLogs(sessionId, sinceId);
  return c.json(logs);
});

sessionsRoutes.get(
  '/api/ws',
  upgradeWebSocket((c) => createTerminalWsHandlers(c)),
);
