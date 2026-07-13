import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { cors } from 'hono/cors';
import { authMiddleware } from './auth';
import { getAuthHash, getLogs, getSession, listSessions, renameSession, setAuthHash } from './db';
import {
  getDefaultShell,
  killSession,
  resizeSession,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';

const app = new Hono();

// API/WebSocket-only server (mobile client). CORS open for LAN access.
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Health/root — liveness only, no data. Left open so `tether status` can probe it.
app.get('/', (c) => c.json({ ok: true, service: 'tether' }));

// Everything under /api/* requires the shared password, EXCEPT the first-run
// pairing endpoints (/api/status, /api/setup), which the middleware exempts.
app.use('/api/*', authMiddleware);

// First-run pairing (unauthenticated): does the server need a password yet?
app.get('/api/status', (c) => c.json({ needsSetup: getAuthHash() === null }));

// First-run pairing (unauthenticated, one-time): set the password iff none exists.
// TOFU — safe only on a trusted LAN/tunnel; self-locks once a hash is stored.
app.post('/api/setup', async (c) => {
  if (getAuthHash()) return c.json({ error: 'already_setup' }, 409);
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 1) return c.json({ error: 'empty' }, 400);
  setAuthHash(await Bun.password.hash(password, { algorithm: 'argon2id' }));
  return c.json({ ok: true });
});

// Lightweight authed reachability + password probe for the client's Test connection.
app.get('/api/health', (c) => c.json({ ok: true }));

// --- HTTP API Routes ---

// List all sessions (active or stopped) from DB
app.get('/api/sessions', (c) => {
  return c.json(listSessions());
});

// Start or get a session
app.post('/api/sessions/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.id || 'default';
  const command = body.command || getDefaultShell();
  const cols = Number(body.cols || 80);
  const rows = Number(body.rows || 24);

  await startSession(sessionId, command, cols, rows);
  const session = getSession(sessionId);
  return c.json({ ok: true, session });
});

// Force-kill a session
app.post('/api/sessions/kill', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.id || 'default';

  const killed = killSession(sessionId);
  return c.json({ ok: killed });
});

app.post('/api/sessions/rename', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return c.json({ ok: false, error: 'missing id' }, 400);
  const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
  renameSession(id, trimmed.length ? trimmed : null);
  return c.json({ ok: true });
});

// Fetch log history for a session (e.g. for full reload)
app.get('/api/sessions/:id/logs', (c) => {
  const sessionId = c.req.param('id');
  const sinceId = Number(c.req.query('sinceId') || 0);

  const logs = getLogs(sessionId, sinceId);
  return c.json(logs);
});

// --- WebSocket Real-Time Terminal Gateway ---
app.get(
  '/api/ws',
  upgradeWebSocket((c) => {
    const sessionId = c.req.query('sessionId') || 'default';
    const sinceId = Number(c.req.query('sinceId') || 0);
    const cols = Number(c.req.query('cols') || 80);
    const rows = Number(c.req.query('rows') || 24);

    let unsubscribe = () => {};
    // Stable per-connection output handler. Defined synchronously in onOpen so it
    // also serves as this client's key for per-client PTY sizing (onMessage/resize).
    let onData: (data: {
      type: 'output' | 'exit';
      chunk?: string;
      exitCode?: number;
      id?: number;
    }) => void = () => {};

    return {
      onOpen(_event, ws) {
        console.log(`WebSocket opened for session "${sessionId}" since log ID: ${sinceId}`);

        onData = (data) => {
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
            }
          } catch (wsErr) {
            // Swallow quietly to avoid PTY reader loop crashes
            console.warn('WebSocket send error during PTY broadcast:', wsErr);
          }
        };

        // Yield execution to let Hono/Bun complete the protocol upgrade before writing
        setTimeout(async () => {
          try {
            // 1. Ensure the PTY process is active (auto-start or holder reattach).
            // Everything after this await runs synchronously, so no PTY frame can
            // slip in between the replay read and the subscribe below.
            await startSession(sessionId, getDefaultShell(), cols, rows);

            // 1b. If the client's sinceId predates pruned rows, the replay has a
            // hole — tell the client to wipe its emulator before the replay.
            const sess = getSession(sessionId);
            if (sinceId > 0 && sess && sinceId < sess.pruned_before) {
              ws.send(JSON.stringify({ type: 'reset' }));
            }

            // 2. Catch up the client: stream any logs missed since the provided log ID
            const missedLogs = getLogs(sessionId, sinceId);
            console.log(`Streaming ${missedLogs.length} missed logs to client...`);
            for (const log of missedLogs) {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'output',
                    id: log.id,
                    chunk: log.chunk,
                  }),
                );
              } catch (sendErr) {
                console.error(`Failed to send log ${log.id} to client:`, sendErr);
                return; // Connection is dead, exit catch-up loop
              }
            }

            // 3. Subscribe client to real-time process output (registers this
            // client's dims and fits the shared PTY to the smallest client).
            unsubscribe = subscribeToSession(sessionId, onData, cols, rows);
          } catch (err) {
            console.error('Error inside settled WebSocket init:', err);
          }
        }, 30);
      },

      onMessage(event, _ws) {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'input') {
            writeToSession(sessionId, msg.text);
          } else if (msg.type === 'resize') {
            resizeSession(sessionId, onData, Number(msg.cols), Number(msg.rows));
          }
        } catch (e) {
          console.error('Failed to handle incoming WebSocket message:', e);
        }
      },

      onClose() {
        console.log(`WebSocket closed for session "${sessionId}"`);
        unsubscribe();
      },
    };
  }),
);

export { app };
