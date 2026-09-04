import type { MiddlewareHandler } from 'hono';
import { getAuthHash } from './db';

// Verify a provided password against the stored argon2 hash.
// No password set ⇒ always false (server refuses until `tether set-password`).
export async function verifyPassword(provided: string): Promise<boolean> {
  const hash = getAuthHash();
  if (!hash) return false;
  try {
    return await Bun.password.verify(provided, hash);
  } catch {
    return false;
  }
}

// Unauthenticated endpoints: the first-run pairing surface. `/api/status`
// reports whether a password exists; `/api/setup` sets it once (TOFU). Both are
// safe to leave open — status leaks no secret, and setup self-locks after use.
//
// The two `/api/noise/*` WebSocket routes are also exempt from the password:
// they are end-to-end-encrypted Noise channels whose handshake (a pairing PSK,
// then a pinned static key on reconnect) IS the authentication — there is no
// password to present over them. See `routes/noise.ts`.
const PUBLIC_API_PATHS = new Set([
  '/api/status',
  '/api/setup',
  '/api/noise/pair',
  '/api/noise/session',
]);

// Reject any request lacking a valid `Authorization: Bearer <password>`.
// Applied to /api/* (including the WS upgrade), on the plaintext and TLS
// listeners alike. This closes the "anyone on the port gets a shell" hole;
// confidentiality is the TLS listener's job (see tlsConfig.ts).
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) return next();
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await verifyPassword(token))) {
    return c.json({ error: 'auth' }, 401);
  }
  await next();
};
