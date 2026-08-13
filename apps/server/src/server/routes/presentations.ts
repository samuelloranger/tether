import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { PRESENT_CONTROL_TOKEN_FILE } from '../paths';
import {
  createControlToken,
  PresentationRegistry,
  resolvePresentationFile,
} from '../presentations';
import { previewMime } from './previewMime';

const presentations = new PresentationRegistry();
export const presentationControlToken = createControlToken(PRESENT_CONTROL_TOKEN_FILE);

export function hasControlToken(value: string | undefined): boolean {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(presentationControlToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const presentationsRoutes = new Hono();

presentationsRoutes.post('/control/presentations', async (c) => {
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

presentationsRoutes.post('/control/presentations/reset', async (c) => {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control')))
    return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    cleared: presentations.reset(typeof body.project === 'string' ? body.project : undefined),
  });
});

presentationsRoutes.get('/preview/:token/*', (c) => {
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

presentationsRoutes.get('/api/presentations', (c) => c.json(presentations.list()));
presentationsRoutes.delete('/api/presentations/:id', (c) =>
  c.json({ ok: presentations.close(c.req.param('id')) }),
);
