import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { cors } from 'hono/cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getSession,
  upsertSession,
  getLogs,
  db
} from './db';
import {
  startSession,
  writeToSession,
  resizeSession,
  subscribeToSession,
  killSession,
  getActiveSession
} from './pty';

const app = new Hono();

// Enable CORS for frontend development
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

const WEB_DIST = path.join(process.cwd(), 'src', 'web', 'dist');
const INDEX_PATH = path.join(WEB_DIST, 'index.html');

// --- HTTP API Routes ---

// List all sessions (active or stopped) from DB
app.get('/api/sessions', (c) => {
  const sessions = db.query('SELECT * FROM sessions ORDER BY created_at DESC').all();
  return c.json(sessions);
});

// Start or get a session
app.post('/api/sessions/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.id || 'default';
  const command = body.command || 'bash';
  const cols = Number(body.cols || 80);
  const rows = Number(body.rows || 24);

  startSession(sessionId, command, cols, rows);
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

    return {
      onOpen(event, ws) {
        console.log(`WebSocket opened for session "${sessionId}" since log ID: ${sinceId}`);

        // Yield execution to let Hono/Bun complete the protocol upgrade before writing
        setTimeout(() => {
          try {
            // 1. Ensure the PTY process is active (auto-start if needed)
            startSession(sessionId, 'bash', cols, rows);

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
                  })
                );
              } catch (sendErr) {
                console.error(`Failed to send log ${log.id} to client:`, sendErr);
                return; // Connection is dead, exit catch-up loop
              }
            }

            // 3. Subscribe client to real-time process output
            unsubscribe = subscribeToSession(sessionId, (data) => {
              try {
                if (data.type === 'output') {
                  ws.send(
                    JSON.stringify({
                      type: 'output',
                      chunk: data.chunk,
                      id: data.id,
                    })
                  );
                } else if (data.type === 'exit') {
                  ws.send(
                    JSON.stringify({
                      type: 'exit',
                      exitCode: data.exitCode,
                    })
                  );
                }
              } catch (wsErr) {
                // Swallow quietly to avoid PTY reader loop crashes
                console.warn('WebSocket send error during PTY broadcast:', wsErr);
              }
            });
          } catch (err) {
            console.error('Error inside settled WebSocket init:', err);
          }
        }, 30);
      },

      onMessage(event, ws) {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'input') {
            writeToSession(sessionId, msg.text);
          } else if (msg.type === 'resize') {
            resizeSession(sessionId, Number(msg.cols), Number(msg.rows));
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
  })
);

// --- Serving Frontend Static Files (Bun direct file system streaming) ---
async function serveStatic(c: any) {
  const resolved = path.resolve(WEB_DIST, `.${c.req.path}`);
  if (resolved !== WEB_DIST && !resolved.startsWith(WEB_DIST + path.sep)) {
    return c.notFound();
  }
  const file = Bun.file(resolved);
  if (!(await file.exists())) return c.notFound();
  
  c.header('Content-Type', file.type || 'application/octet-stream');
  
  if (c.req.path === '/sw.js' || c.req.path === '/manifest.webmanifest') {
    c.header('Cache-Control', 'no-cache');
  } else {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
  return c.body(file.stream());
}

app.get('/assets/*', serveStatic);
app.get('/favicon.svg', serveStatic);
app.get('/icons.svg', serveStatic);
app.get('/manifest.webmanifest', serveStatic);
app.get('/sw.js', serveStatic);

// Catch-all route to serve Svelte frontend (HTML5 routing)
app.get('*', async (c) => {
  const html = await readFile(INDEX_PATH, 'utf-8').catch(() => null);
  if (!html) {
    return c.text('Tether frontend not built. Run "bun run build" first.', 503);
  }
  c.header('Cache-Control', 'no-cache');
  return c.html(html);
});

export { app };
