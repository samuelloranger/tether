import { websocket } from 'hono/bun';
import { app } from './app';
import { resetRunningSessions, setSessionStatus } from './db';
import { reattachHolders } from './pty';

const PORT = Number(process.env.TETHER_PORT ?? 8085);

// A previous server process may have died with sessions still marked running.
// Their PTYs live in detached holder processes, so first reattach to the ones
// that survived, then mark whatever is left as stopped.
resetRunningSessions();
for (const id of await reattachHolders()) {
  setSessionStatus(id, 'running');
  console.log(`Reattached to surviving session "${id}"`);
}

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
