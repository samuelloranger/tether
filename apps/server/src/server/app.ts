import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { cors } from 'hono/cors';
import { authMiddleware } from './auth';
import {
  getAuthHash,
  getLogs,
  getSession,
  listSessions,
  renameSession,
  setAuthHashIfUnset,
} from './db';
import { GitDiffError, readDiff, readDiffBlob, readDiffSummary } from './gitDiff';
import { resolveGitRoot } from './gitRoot';
import { getLiveCwd } from './liveCwd';
import { PRESENT_CONTROL_TOKEN_FILE, UPLOADS_DIR } from './paths';
import { createControlToken, PresentationRegistry, resolvePresentationFile } from './presentations';
import {
  getActiveSession,
  getDefaultShell,
  killSession,
  resizeSession,
  type Subscriber,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { resolveUploadPath } from './upload';
import { readWorkspaceFile, WorkspaceFileError } from './workspaceFile';

const app = new Hono();
const presentations = new PresentationRegistry();
export const presentationControlToken = createControlToken(PRESENT_CONTROL_TOKEN_FILE);

export function hasControlToken(value: string | undefined): boolean {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(presentationControlToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A browser attaches an Origin header; a native RN/Tauri client does not. When
// an Origin is present we require it to match the Host we were reached on, so a
// random web page can't script the unauthenticated first-run setup on the LAN.
function setupOriginOk(c: { req: { header(name: string): string | undefined } }): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true; // native client — no browser same-origin concept
  const host = c.req.header('Host');
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

const PREVIEW_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function previewMime(file: string): string {
  return PREVIEW_MIME_TYPES[path.extname(file)] || 'application/octet-stream';
}

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

app.post('/control/presentations', async (c) => {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control')))
    return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.entry !== 'string') return c.json({ error: 'missing entry' }, 400);
  try {
    return c.json(
      presentations.create({
        entry: body.entry,
        project: typeof body.project === 'string' ? body.project : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      }),
    );
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

app.post('/control/presentations/reset', async (c) => {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control')))
    return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    cleared: presentations.reset(typeof body.project === 'string' ? body.project : undefined),
  });
});

app.get('/preview/:token/*', (c) => {
  const preview = presentations.findByToken(c.req.param('token'));
  if (!preview) return c.notFound();
  try {
    const prefix = `/preview/${preview.token}/`;
    const file = resolvePresentationFile(
      preview.root,
      decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length)),
    );
    return new Response(Bun.file(file), {
      headers: { 'Content-Type': previewMime(file), 'Cache-Control': 'no-store' },
    });
  } catch {
    return c.notFound();
  }
});

// Everything under /api/* requires the shared password, EXCEPT the first-run
// pairing endpoints (/api/status, /api/setup), which the middleware exempts.
app.use('/api/*', authMiddleware);

app.get('/api/presentations', (c) => c.json(presentations.list()));
app.delete('/api/presentations/:id', (c) => c.json({ ok: presentations.close(c.req.param('id')) }));

// First-run pairing (unauthenticated): does the server need a password yet?
app.get('/api/status', (c) => c.json({ needsSetup: getAuthHash() === null }));

// First-run pairing (unauthenticated, one-time): set the password iff none exists.
// TOFU — safe only on a trusted LAN/tunnel; self-locks once a hash is stored.
app.post('/api/setup', async (c) => {
  if (!setupOriginOk(c)) return c.json({ error: 'forbidden_origin' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 1) return c.json({ error: 'empty' }, 400);
  // Hash first, then attempt the atomic claim; if we lost the race the insert
  // does nothing and we report already_setup — no check-then-write window.
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
  if (!setAuthHashIfUnset(hash)) return c.json({ error: 'already_setup' }, 409);
  return c.json({ ok: true });
});

// Lightweight authed reachability + password probe for the client's Test connection.
app.get('/api/health', (c) => c.json({ ok: true }));

// --- HTTP API Routes ---

// List all sessions (active or stopped) from DB
app.get('/api/sessions', (c) => {
  return c.json(listSessions());
});

app.get('/api/sessions/:id/file', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readWorkspaceFile(resolveGitRoot(cwd), c.req.query('path') ?? '', cwd));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.get('/api/sessions/:id/diff/summary', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readDiffSummary(resolveGitRoot(cwd)));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.get('/api/sessions/:id/diff', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(await readDiff(resolveGitRoot(cwd), c.req.query('path')));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Raw bytes for one side of a binary (typically image) file diff — 'old' is
// the committed blob, 'new' is the working tree copy. Either side can be
// legitimately absent (added/deleted file), reported as 404.
app.get('/api/sessions/:id/diff/file', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  const requestedPath = c.req.query('path');
  const side = c.req.query('side');
  if (!requestedPath || (side !== 'old' && side !== 'new')) {
    return c.json({ error: 'invalid path or side' }, 400);
  }
  try {
    const bytes = readDiffBlob(resolveGitRoot(cwd), side, requestedPath);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': previewMime(requestedPath), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
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

// Receive an uploaded file (mobile image-picker, iOS/iPadOS drag-drop, desktop
// drag-drop all funnel through here) and write it into a per-session upload
// dir under ~/.tether/uploads, not the session's live cwd — keeps uploads out
// of whatever project the user happens to be working in.
app.post('/api/sessions/:id/upload', async (c) => {
  const sessionId = c.req.param('id');
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: 'invalid form data' }, 400);
  const file = form.get('file');
  const filenameOverride = form.get('filename');
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'missing file' }, 400);
  }
  const filename =
    typeof filenameOverride === 'string' && filenameOverride ? filenameOverride : file.name;
  const dir = path.join(UPLOADS_DIR, sessionId);
  let dest: string;
  try {
    mkdirSync(dir, { recursive: true });
    dest = resolveUploadPath(dir, filename);
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400);
  }
  await Bun.write(dest, file);
  return c.json({ ok: true, path: dest });
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
    // The subscribe-to-session call is deferred (see the setTimeout below), so a
    // client that disconnects before it runs must stop it from ever registering
    // — otherwise its dims/subscriber entry leaks forever, since onClose only
    // fires once and unsubscribe is still the no-op at that point.
    let closed = false;
    // Stable per-connection output handler. Defined synchronously in onOpen so it
    // also serves as this client's key for per-client PTY sizing (onMessage/resize).
    let onData: Subscriber = () => {};

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
            } else if (data.type === 'diff') {
              ws.send(JSON.stringify({ type: 'diff', summary: data.summary }));
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
            // Skip if the client already disconnected during the awaits above —
            // onClose already ran (unsubscribe was still the no-op), so a late
            // subscribe here would never get cleaned up.
            if (closed) return;
            unsubscribe = subscribeToSession(sessionId, onData, cols, rows);
            // If the session exited during the awaits above, subscribe returned
            // the no-op and no exit will ever arrive — tell the client now so it
            // doesn't render a dead terminal as live.
            if (!getActiveSession(sessionId)) {
              ws.send(JSON.stringify({ type: 'exit' }));
            }
          } catch (err) {
            console.error('Error inside settled WebSocket init:', err);
          }
        }, 30);
      },

      onMessage(event, _ws) {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'input' && typeof msg.text === 'string') {
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
        closed = true;
        unsubscribe();
      },
    };
  }),
);

export { app };
