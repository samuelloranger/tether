import type { MiddlewareHandler } from 'hono';
import { looksLikeToken, verifyToken } from './deviceToken';

// Unauthenticated endpoints: discovery + Noise handshakes.
// `/api/status` reports TLS facts and leaks no secret.
//
// The `/api/noise/*` WebSocket routes are also exempt: they are end-to-end
// encrypted Noise channels whose handshake (a pairing PSK, then a pinned static
// key on reconnect) IS the authentication. See `routes/noise.ts`.
const PUBLIC_API_PATHS = new Set(['/api/status', '/api/noise/pair', '/api/noise/session']);

// Reject any request lacking a valid per-device bearer token. Applied to /api/*
// (including the WS upgrade), on the plaintext and TLS listeners alike.
// There is no shared password — a paired device mints a token over Noise.
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) return next();
  const header = c.req.header('Authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (bearer && looksLikeToken(bearer) && verifyToken(bearer)) {
    await next();
    return;
  }
  return c.json({ error: 'auth' }, 401);
};
