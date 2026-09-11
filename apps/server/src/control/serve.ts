import { logError, logInfo } from '@/infra/log';
import { CONTROL_SOCK } from '@/infra/paths';
import { controlApp } from './app';
import { hardenControlSocket, prepareControlSocket } from './socket';

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
