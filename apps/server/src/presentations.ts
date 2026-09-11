import { randomBytes, randomUUID } from 'node:crypto';
import { type FSWatcher, statSync, watch } from 'node:fs';
import path from 'node:path';
import { canonicalPath, inside } from './workspaceFile';

// A preview URL carries its capability token in plaintext; bound its lifetime so
// a leaked link (chat log, browser history, Referer) dies instead of living for
// the daemon's whole run. The authed poll (list()) renews it — see below.
export const PREVIEW_TTL_MS = 15 * 60_000;

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}

interface InternalPresentation extends Presentation {
  root: string;
  token: string;
  expiresAt: number;
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

  constructor(
    private readonly debounceMs = 150,
    private readonly ttlMs = PREVIEW_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

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
      expiresAt: this.now() + this.ttlMs,
      watcher: undefined as unknown as FSWatcher,
      timer: null,
    };
    preview.watcher = watch(root, { recursive: true }, () => this.bump(preview));
    this.previews.set(id, preview);
    return this.public(preview);
  }

  list(): Presentation[] {
    // The renewal path. GET /api/presentations is bearer-gated, so only a paired
    // device polling here extends a preview's life; a naked /preview GET cannot
    // slide its own window. Same token string back → the client's iframe/webview
    // src is unchanged, so no reload churn.
    const renewed = this.now() + this.ttlMs;
    const out: Presentation[] = [];
    for (const preview of this.previews.values()) {
      preview.expiresAt = renewed;
      out.push(this.public(preview));
    }
    return out;
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
    if (!preview) return null;
    // Expired: treat as absent and drop it, releasing the watcher. Renewal is the
    // authed poll's job (list()); a request on the token itself never renews.
    if (this.now() > preview.expiresAt) {
      this.close(preview.id);
      return null;
    }
    return { ...this.public(preview), root: preview.root, token: preview.token };
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
