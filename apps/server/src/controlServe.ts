import { controlApp } from './controlApp';
import { hardenControlSocket, prepareControlSocket } from './controlSocket';
import { logError, logInfo } from './log';
import { CONTROL_SOCK } from './paths';

export function serveControl(sock: string = CONTROL_SOCK) {
  prepareControlSocket(sock);
  const server = Bun.serve({
    unix: sock,
    fetch: (req) => controlApp.fetch(req),
    error(err: Error) {
      logError('Control socket request error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  });
  hardenControlSocket(sock);
  logInfo(`Control plane on unix socket ${sock}`);
  return server;
}
