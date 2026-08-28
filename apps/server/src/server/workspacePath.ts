import path from 'node:path';

/**
 * Render a workspace-relative path the way clients expect to see it.
 *
 * `path.relative` emits the host separator, so the same file is "src/main.ts"
 * on Linux and "src\main.ts" on Windows. That value is not just internal — it
 * goes over the API into the file tree and the file viewer, and is what a
 * client echoes back as `requestedPath`. Forward slashes are the convention for
 * a path on the wire (git does the same), so a Windows host describes its
 * workspace identically to every other host and one client build can render
 * both.
 *
 * Deliberately a no-op off Windows rather than a blanket replace: a backslash
 * is a legal character in a POSIX filename, and rewriting it there would
 * corrupt a real name into a fake directory boundary.
 */
export function toWorkspacePath(relative: string): string {
  return path.sep === '\\' ? relative.split('\\').join('/') : relative;
}
