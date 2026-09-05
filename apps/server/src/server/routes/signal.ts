import { Hono } from 'hono';
import type { SignalState } from '../sessionActivity';
import { signalSession } from '../signalSession';
import { hasControlToken } from './presentations';

const STATES: readonly SignalState[] = ['working', 'waiting', 'done'];

function isSignalState(value: unknown): value is SignalState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

function words(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, limit) : undefined;
}

export const signalRoutes = new Hono();

/**
 * A program telling the server what it is doing. Authed by the same control
 * token as /control/presentations; sessionId comes from TETHER_SESSION_ID.
 */
signalRoutes.post('/control/signal', async (c) => {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control')))
    return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.sessionId !== 'string' || !body.sessionId)
    return c.json({ error: 'missing sessionId' }, 400);
  if (!isSignalState(body.state))
    return c.json({ error: `state must be one of ${STATES.join(', ')}` }, 400);
  const known = signalSession(body.sessionId, body.state, {
    title: words(body.title, 100),
    body: words(body.body, 400),
  });
  if (!known) return c.json({ error: 'unknown session' }, 404);
  return c.json({ ok: true });
});
