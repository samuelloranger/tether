import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { allowAdminRequest, scheduleAdminCommand, updateTargetVersion } from './admin';
import { authMiddleware } from './auth';
import { getConfig } from './config';
import { logError, logInfo } from './log';
import { pairControlRoutes } from './pairControl';
import { sendTestPush } from './push';
import { isValidSecretKey } from './pushCrypto';
import { registerPushDevice, removePushDevice } from './pushDevices';
import { configRoutes } from './routes/config';
import { filesRoutes } from './routes/files';
import { gitRoutes } from './routes/git';
import { noiseRoutes } from './routes/noise';
import {
  hasControlToken,
  presentationControlToken,
  presentationsRoutes,
} from './routes/presentations';
import { sessionsRoutes } from './routes/sessions';
import { signalRoutes } from './routes/signal';
import { VERSION } from './runtime';
import { getTlsReport, isSecureRequest } from './tlsRuntime';

export { hasControlToken, presentationControlToken };

/** Bindings come from Bun.serve's fetch wrapper in serve.ts (peer + server). */
export type AppEnv = {
  Bindings: {
    peerAddress?: string;
    // Bun.Server — kept loose so tests can pass { peerAddress } without a real server.
    server?: object;
  };
  Variables: {
    peerAddress: string;
    deviceId?: string;
  };
};

const app = new Hono<AppEnv>();

// Rate-limit key is the SOCKET peer, never a client-controlled header. Unknown
// peers share one bucket — over-limiting is the safe direction.
function clientKey(c: Context<AppEnv>): string {
  return c.get('peerAddress') || 'unknown';
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

app.use('*', async (c, next) => {
  const fromEnv = c.env?.peerAddress;
  c.set('peerAddress', typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : 'unknown');
  await next();
});

// Health/root — liveness only, no data. Left open so `tether status` can probe it.
app.get('/', (c) => c.json({ ok: true, service: 'tether' }));

// Everything under /api/* requires a per-device bearer token, except the
// unauthenticated discovery and Noise handshake endpoints (/api/status, /api/noise/*).
app.use('/api/*', authMiddleware);

// Unauthenticated discovery. `secure` reflects the actual socket (TLS vs
// plaintext), never a header — a client may only pin a fingerprint read over TLS.
app.get('/api/status', (c) =>
  c.json({
    secure: isSecureRequest(c.req.url),
    tls: getTlsReport(),
  }),
);

// Lightweight authed reachability probe for the client's Test connection.
app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

app.post('/api/admin/update', async (c) => {
  if (!allowAdminRequest(clientKey(c))) {
    return c.json({ error: 'rate limited' }, 429);
  }
  logInfo('Admin update requested');
  scheduleAdminCommand('update');
  return c.json({ ok: true, targetVersion: updateTargetVersion() });
});

app.post('/api/admin/restart', async (c) => {
  if (!allowAdminRequest(clientKey(c))) {
    return c.json({ error: 'rate limited' }, 429);
  }
  logInfo('Admin restart requested');
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
    logError('Test notification delivery failed:', error);
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

// The device generates its own AES key here; confidentiality is bounded by the
// transport — same channel that streams the terminal, so run Tether behind a tunnel.
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
  registerPushDevice(deviceToken, secretKey, label, c.get('deviceId'));
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
app.route('/', pairControlRoutes);
app.route('/', noiseRoutes);
app.route('/', configRoutes);
app.route('/', filesRoutes);
app.route('/', gitRoutes);
app.route('/', sessionsRoutes);
app.route('/', signalRoutes);

export { app };
