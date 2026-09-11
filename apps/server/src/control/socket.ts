import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export function prepareControlSocket(sock: string): void {
  mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  // mode on mkdirSync is masked by umask; force it so the dir is owner-only.
  try {
    chmodSync(path.dirname(sock), 0o700);
  } catch {
    // ignore: a filesystem that does not implement mode bits
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
