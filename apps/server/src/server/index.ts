import { websocket } from 'hono/bun';
import { app } from './app';
import { resetRunningSessions } from './db';

const PORT = Number(process.env.TETHER_PORT ?? 8085);

// A previous server process may have died with sessions still marked running;
// their PTYs are gone, so reflect reality before serving the session list.
resetRunningSessions();

console.log(`Tether server listening on :${PORT}`);

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket,
  error(err) {
    console.error('Unhandled request error:', err);
    return new Response('Internal Server Error', { status: 500 });
  },
});
