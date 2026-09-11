import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether something is still accepting connections on `sock`.
 *
 * A unix socket file outlives the process that bound it, and `ss` keeps
 * reporting the bind-time name even after the file is replaced — so the file's
 * presence says nothing. Connecting is the only honest test.
 */
export async function controlSocketIsLive(sock: string): Promise<boolean> {
  if (!existsSync(sock)) return false;
  try {
    const conn = await Bun.connect({ unix: sock, socket: { data() {} } });
    conn.end();
    return true;
  } catch {
    return false;
  }
}

export async function prepareControlSocket(sock: string): Promise<void> {
  mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  // mode on mkdirSync is masked by umask; force it so the dir is owner-only.
  try {
    chmodSync(path.dirname(sock), 0o700);
  } catch {
    // ignore: a filesystem that does not implement mode bits
  }
  // Stealing the path from a running daemon is worse than refusing to start:
  // the unlink does not stop the old listener, it only makes it unreachable, so
  // every CLI that later connects here gets ECONNREFUSED against a socket file
  // that looks fine and a daemon that still reports itself healthy.
  if (await controlSocketIsLive(sock)) {
    throw new Error(
      `Another tether daemon is already serving ${sock}. Stop it (tether stop) or point this one elsewhere with TETHER_CONTROL_SOCK.`,
    );
  }
  // A prior daemon that did not shut down cleanly leaves the socket file behind;
  // Bun.serve refuses to bind an existing path. force:true = no throw if absent.
  rmSync(sock, { force: true });
}

export function hardenControlSocket(sock: string): void {
  // Filesystem perms are the auth here. On a FS that ignores mode the socket is
  // still confined to the local machine, so a failure is not fatal.
  try {
    chmodSync(sock, 0o600);
  } catch {
    // ignore
  }
}
