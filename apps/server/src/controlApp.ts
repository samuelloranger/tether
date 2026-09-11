import { Hono } from 'hono';
import { pairControl } from '@/auth/pairControl';
import { presentations } from '@/presentations/instance';
import type { SignalState } from '@/pty/activity';
import { signalSession } from '@/pty/signal';

// The control plane. Served ONLY over the loopback unix socket (controlServe.ts),
// never on the network listeners — so there is no token gate here: a process
// that can open the 0600 socket is already local. The `tether present|signal|
// pair` CLIs are the only callers.

const SIGNAL_STATES: readonly SignalState[] = ['working', 'waiting', 'done'];
const isSignalState = (v: unknown): v is SignalState =>
  typeof v === 'string' && (SIGNAL_STATES as readonly string[]).includes(v);
const words = (v: unknown, limit: number): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, limit) : undefined;

export const controlApp = new Hono();

controlApp.post('/control/presentations', async (c) => {
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

controlApp.post('/control/presentations/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    cleared: presentations.reset(typeof body.project === 'string' ? body.project : undefined),
  });
});

controlApp.post('/control/signal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.sessionId !== 'string' || !body.sessionId)
    return c.json({ error: 'missing sessionId' }, 400);
  if (!isSignalState(body.state))
    return c.json({ error: `state must be one of ${SIGNAL_STATES.join(', ')}` }, 400);
  const known = signalSession(body.sessionId, body.state, {
    title: words(body.title, 100),
    body: words(body.body, 400),
  });
  if (!known) return c.json({ error: 'unknown session' }, 404);
  return c.json({ ok: true });
});

controlApp.route('/', pairControl.routes);
