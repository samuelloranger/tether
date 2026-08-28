import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  watch,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { secureWindowsPath } from './winAcl';
import { canonicalPath, inside } from './workspaceFile';

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}

export function createControlToken(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    // 'wx' plus 0o600: create-or-fail, owner-only. The mode is the whole point —
    // this token authorises /control/signal and /control/presentations, so any
    // account that can read the file can drive every session's activity state
    // and register previews.
    const fd = openSync(file, 'wx', 0o600);
    const token = randomBytes(24).toString('hex');
    writeSync(fd, token);
    closeSync(fd);
    // The 0o600 above is a no-op on Windows, and this file's parent is ~/.tether
    // — created without a mode and shared with the pid file and the log, so
    // there is no owner-only directory grant here for the token to inherit.
    // Unlike the holder sockets it has to be secured in its own right.
    //
    // After closeSync, not before: icacls opens the target itself, and rewriting
    // the DACL of a file we still hold a write handle to is needless contention.
    // Only in the create branch — on every later boot the open throws EEXIST and
    // the ACL set on first boot is still in force, so there is nothing to redo.
    secureWindowsPath(file, false);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readFileSync(file, 'utf8').trim();
  }
}

interface InternalPresentation extends Presentation {
  root: string;
  token: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

export function resolvePresentationFile(root: string, requested: string): string {
  // Same containment primitives as the workspace file/dir routes, for the same
  // reason: a raw `===`/`startsWith` pair is a case-SENSITIVE comparison, and on
  // a case-insensitive Windows volume `C:\p\x` and `c:\P\x` are one directory
  // that compares unequal. See canonicalPath/inside in workspaceFile.ts.
  const canonicalRoot = canonicalPath(root);
  // Checked twice on purpose. The first pass rejects a lexical `..` before the
  // path is ever resolved; the second re-checks what the symlinks actually
  // resolved to, which is the only form that can be trusted.
  const attempted = path.resolve(canonicalRoot, requested);
  if (!inside(canonicalRoot, attempted)) {
    throw new Error('preview path escapes its root');
  }
  const candidate = canonicalPath(attempted);
  if (!inside(canonicalRoot, candidate)) {
    throw new Error('preview path escapes its root');
  }
  if (statSync(candidate).isDirectory()) {
    throw new Error('preview path is a directory');
  }
  return candidate;
}

export class PresentationRegistry {
  private readonly previews = new Map<string, InternalPresentation>();

  constructor(private readonly debounceMs = 150) {}

  create(input: {
    entry: string;
    project?: string;
    title?: string;
    sessionId?: string;
  }): Presentation {
    // canonicalPath, so the root stored on the preview is already in the form
    // resolvePresentationFile will compare against on every /preview request.
    const entry = canonicalPath(input.entry);
    if (path.extname(entry).toLowerCase() !== '.html')
      throw new Error('preview entry must be an HTML file');
    const root = path.dirname(entry);
    const id = randomUUID();
    const token = randomBytes(24).toString('hex');
    const preview: InternalPresentation = {
      id,
      title: input.title || path.basename(entry, path.extname(entry)),
      project: input.project || path.basename(root),
      revision: 0,
      url: `/preview/${token}/${path.basename(entry)}`,
      sessionId: input.sessionId,
      root,
      token,
      watcher: undefined as unknown as FSWatcher,
      timer: null,
    };
    preview.watcher = watch(root, { recursive: true }, () => this.bump(preview));
    this.previews.set(id, preview);
    return this.public(preview);
  }

  list(): Presentation[] {
    return [...this.previews.values()].map((preview) => this.public(preview));
  }

  close(id: string): boolean {
    const preview = this.previews.get(id);
    if (!preview) return false;
    if (preview.timer) clearTimeout(preview.timer);
    preview.watcher.close();
    this.previews.delete(id);
    return true;
  }

  reset(project?: string): number {
    const ids = [...this.previews.values()]
      .filter((preview) => project === undefined || preview.project === project)
      .map((preview) => preview.id);
    for (const id of ids) this.close(id);
    return ids.length;
  }

  findByToken(token: string): (Presentation & { root: string; token: string }) | null {
    const preview = [...this.previews.values()].find((item) => item.token === token);
    return preview ? { ...this.public(preview), root: preview.root, token: preview.token } : null;
  }

  dispose(): void {
    this.reset();
  }

  private bump(preview: InternalPresentation): void {
    if (preview.timer) clearTimeout(preview.timer);
    preview.timer = setTimeout(() => {
      preview.timer = null;
      if (this.previews.has(preview.id)) preview.revision++;
    }, this.debounceMs);
  }

  private public(preview: InternalPresentation): Presentation {
    return {
      id: preview.id,
      title: preview.title,
      project: preview.project,
      revision: preview.revision,
      url: preview.url,
      sessionId: preview.sessionId,
    };
  }
}
