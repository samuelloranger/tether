import { Hono } from 'hono';
import { presentations } from '@/presentations/instance';
import { resolvePresentationFile } from '@/presentations/registry';
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
      headers: {
        'Content-Type': previewMime(file),
        'Cache-Control': 'no-store',
        // The capability token rides the URL; keep it out of any Referer the
        // presented page's external requests would otherwise carry.
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return c.notFound();
  }
});

presentationsRoutes.get('/api/presentations', (c) => c.json(presentations.list()));
presentationsRoutes.delete('/api/presentations/:id', (c) =>
  c.json({ ok: presentations.close(c.req.param('id')) }),
);
