import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  allowAdminRequest,
  changePassword,
  requireCurrentPassword,
  scheduleAdminCommand,
  updateTargetVersion,
} from './admin';
import { authMiddleware } from './auth';
import { getConfig } from './config';
import { getAuthHash, setAuthHashIfUnset } from './db';
import { sendTestPush } from './push';
import { isValidSecretKey } from './pushCrypto';
import { registerPushDevice, removePushDevice } from './pushDevices';
import { configRoutes } from './routes/config';
import { filesRoutes } from './routes/files';
import { gitRoutes } from './routes/git';
import {
  hasControlToken,
  presentationControlToken,
  presentationsRoutes,
} from './routes/presentations';
import { sessionsRoutes } from './routes/sessions';
import { VERSION } from './runtime';
import { getTlsReport, isSecureRequest } from './tlsRuntime';

export { hasControlToken, presentationControlToken };

const app = new Hono();

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

function clientKey(c: Context): string {
  return c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP') ?? 'local';
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

// Everything under /api/* requires the shared password, EXCEPT the first-run
// pairing endpoints (/api/status, /api/setup), which the middleware exempts.
app.use('/api/*', authMiddleware);

// First-run pairing (unauthenticated): does the server need a password yet, and
// how should the client reach us?
//
// `tls.fingerprint` is what a client pins. Pinning on first contact is only as
// good as that first contact, so two things matter here:
//   - `secure` reports whether THIS response came over the TLS listener. It is
//     derived from the socket, never from a header. A client must only pin a
//     fingerprint it read over TLS, and must compare it against the certificate
//     it actually saw on that connection — self-reported bytes over plaintext
//     are a MITM's to rewrite, and are advisory discovery only.
//   - A mismatch between the pinned value and the observed peer certificate is
//     a hard failure, not a re-pair prompt.
app.get('/api/status', (c) =>
  c.json({
    needsSetup: getAuthHash() === null,
    secure: isSecureRequest(c.req.url),
    tls: getTlsReport(),
  }),
);

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
  // Echo the transport facts so a client can pair and pin in one round trip,
  // under the same rule as /api/status: only pin what came over TLS.
  return c.json({ ok: true, secure: isSecureRequest(c.req.url), tls: getTlsReport() });
});

// Lightweight authed reachability + password probe for the client's Test connection.
app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

app.post('/api/admin/password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await changePassword(body.current, body.next, clientKey(c)))) {
    return c.json({ error: 'invalid current password or rate limited' }, 403);
  }
  console.log(`Admin password changed at ${new Date().toISOString()}`);
  return c.json({ ok: true });
});

app.post('/api/admin/update', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireCurrentPassword(body.current, clientKey(c)))) {
    return c.json({ error: 'invalid current password or rate limited' }, 403);
  }
  console.log(`Admin update requested at ${new Date().toISOString()}`);
  scheduleAdminCommand('update');
  return c.json({ ok: true, targetVersion: updateTargetVersion() });
});

app.post('/api/admin/restart', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireCurrentPassword(body.current, clientKey(c)))) {
    return c.json({ error: 'invalid current password or rate limited' }, 403);
  }
  console.log(`Admin restart requested at ${new Date().toISOString()}`);
  scheduleAdminCommand('restart');
  return c.json({ ok: true });
});

app.post('/api/admin/test-notification', async (c) => {
  if (!allowAdminRequest(clientKey(c))) {
    return c.json({ ok: false, error: 'rate limited' }, 429);
  }
  // Deliberately not gated on `push.enabled`: sending a test is how you check
  // the path works before turning it on.
  try {
    await sendTestPush(getConfig());
    return c.json({ ok: true });
  } catch (error) {
    console.error('Test notification delivery failed:', error);
    return c.json(
      {
        ok: false,
        // The message names the actual cause ("no devices registered" vs. the
        // relay's status) — a generic string here reads as a broken feature.
        error: error instanceof Error ? error.message : 'Notification delivery failed.',
        code: 'notification_delivery_failed',
      },
      502,
    );
  }
});

// The device generates its own AES key and hands it over here. This rides the
// normal token-authed API, so its confidentiality is bounded by the transport —
// the same channel already streams the terminal itself, so this adds no new
// exposure, but it is another reason to run Tether behind a tunnel.
app.post('/api/push/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const deviceToken = typeof body.deviceToken === 'string' ? body.deviceToken.trim() : '';
  const secretKey = typeof body.secretKey === 'string' ? body.secretKey : '';
  if (!/^[0-9a-fA-F]{64}$/.test(deviceToken)) {
    return c.json({ ok: false, error: 'invalid deviceToken' }, 400);
  }
  if (!isValidSecretKey(secretKey)) {
    return c.json({ ok: false, error: 'secretKey must be 32 bytes, base64' }, 400);
  }
  const label = typeof body.label === 'string' ? body.label.slice(0, 100) : undefined;
  registerPushDevice(deviceToken, secretKey, label);
  return c.json({ ok: true });
});

app.post('/api/push/unregister', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const deviceToken = typeof body.deviceToken === 'string' ? body.deviceToken.trim() : '';
  if (!deviceToken) return c.json({ ok: false, error: 'missing deviceToken' }, 400);
  removePushDevice(deviceToken);
  return c.json({ ok: true });
});

app.route('/', presentationsRoutes);
app.route('/', configRoutes);
app.route('/', filesRoutes);
app.route('/', gitRoutes);
app.route('/', sessionsRoutes);

export { app };
