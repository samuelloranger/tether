import type { MiddlewareHandler } from 'hono';
import { looksLikeToken, verifyToken } from './deviceToken';

// Unauthenticated: /api/status (leaks no secret) and /api/noise/* — those Noise
// handshakes (pairing PSK, then pinned static key) ARE the authentication.
const PUBLIC_API_PATHS = new Set(['/api/status', '/api/noise/pair', '/api/noise/session']);

// Applied to /api/* (including the WS upgrade) on both listeners. There is no
// shared password — a paired device mints a token over Noise.
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) return next();
  const header = c.req.header('Authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const verified = verifyToken(bearer);
  if (bearer && looksLikeToken(bearer) && verified) {
    c.set('deviceId', verified.deviceId);
    await next();
    return;
  }
  return c.json({ error: 'auth' }, 401);
};
