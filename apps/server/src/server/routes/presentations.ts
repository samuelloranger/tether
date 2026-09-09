import { Hono } from 'hono';
import { presentations } from '../presentationRegistry';
import { resolvePresentationFile } from '../presentations';
import { previewMime } from './previewMime';

export const presentationsRoutes = new Hono();

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
