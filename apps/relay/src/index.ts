import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { ApnsTokenCache } from './apnsAuth';
import { APNS_PROD, APNS_SANDBOX, ApnsClient } from './apnsClient';
import { buildApnsPayload, classifyApnsStatus, pushRequestSchema } from './payload';
import { RateLimiter } from './rateLimit';

// Every value here is deployment config, never a default that could silently
// point production at the wrong Apple environment or the wrong app.
const KEY_ID = required('APNS_KEY_ID');
const TEAM_ID = required('APNS_TEAM_ID');
const BUNDLE_ID = required('APNS_BUNDLE_ID');
const KEY_PATH = required('APNS_KEY_PATH');
const PORT = Number(process.env.PORT ?? 8090);
// TestFlight and App Store builds are 'production'; a build run from Xcode onto
// a device is 'sandbox'. Sending to the wrong one fails with BadDeviceToken.
const HOST = process.env.APNS_ENV === 'sandbox' ? APNS_SANDBOX : APNS_PROD;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const tokens = new ApnsTokenCache({
  keyId: KEY_ID,
  teamId: TEAM_ID,
  privateKeyPem: readFileSync(KEY_PATH, 'utf8'),
});
const apns = new ApnsClient(tokens, HOST);

// A device realistically needs a handful of notifications a minute; a server
// stuck in a loop needs stopping. Burst of 10, sustained 1 every 6s.
const perToken = new RateLimiter({ capacity: 10, refillPerSecond: 1 / 6 });
const perIp = new RateLimiter({ capacity: 60, refillPerSecond: 1 });
setInterval(() => {
  perToken.sweep();
  perIp.sweep();
}, 60_000).unref?.();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/push', async (c) => {
  const parsed = pushRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', detail: parsed.error.issues[0]?.message }, 400);
  }
  const req = parsed.data;

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!perIp.take(ip) || !perToken.take(req.token)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  let result: Awaited<ReturnType<ApnsClient['send']>>;
  try {
    result = await apns.send({
      token: req.token,
      payload: buildApnsPayload(req),
      topic: BUNDLE_ID,
      collapseId: req.collapseId,
    });
  } catch (error) {
    // Transport failure — the caller may retry. Deliberately not logging the
    // request: the whole point of this service is that it holds no content.
    console.warn('apns transport error:', error instanceof Error ? error.message : error);
    return c.json({ error: 'upstream_unavailable' }, 502);
  }

  switch (classifyApnsStatus(result.status)) {
    case 'ok':
      return c.json({ ok: true });
    case 'unregistered':
      // The app was uninstalled. The relay stores nothing, so the caller is the
      // one that must forget this token.
      return c.json({ error: 'unregistered' }, 410);
    case 'retry':
      return c.json({ error: 'upstream_busy', reason: result.reason }, 503);
    default:
      return c.json({ error: 'rejected', reason: result.reason }, 400);
  }
});

console.log(`tether-relay listening on :${PORT} (${HOST}, topic ${BUNDLE_ID})`);

export default { port: PORT, fetch: app.fetch };
