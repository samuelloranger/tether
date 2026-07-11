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

// Reject any request lacking a valid `Authorization: Bearer <password>`.
// Applied to /api/* (including the WS upgrade). Encryption is the tunnel's job;
// this only closes the "anyone on the port gets a shell" hole.
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await verifyPassword(token))) {
    return c.json({ error: 'auth' }, 401);
  }
  await next();
};
