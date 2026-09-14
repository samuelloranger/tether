import { Hono } from 'hono';
import { presentations } from '@/presentations/instance';

export const presentationsRoutes = new Hono();

presentationsRoutes.get('/api/presentations', (c) => c.json(presentations.list()));

// The self-contained HTML for a preview. Bearer-gated by /api/* middleware; the
// bytes never travel by public URL, so a leaked link exposes nothing.
presentationsRoutes.get('/api/presentations/:id/content', (c) => {
  const content = presentations.content(c.req.param('id'));
  if (content === null) return c.notFound();
  return new Response(content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

presentationsRoutes.delete('/api/presentations/:id', (c) =>
  c.json({ ok: presentations.close(c.req.param('id')) }),
);
