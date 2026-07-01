import { app } from './app';
import { websocket } from 'hono/bun';

const PORT = Number(process.env.TETHER_PORT ?? 8085);

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
