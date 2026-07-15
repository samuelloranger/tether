import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeSync,
} from 'node:fs';
import path from 'node:path';

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
    const fd = openSync(file, 'wx', 0o600);
    const token = randomBytes(24).toString('hex');
    writeSync(fd, token);
    closeSync(fd);
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
  const canonicalRoot = realpathSync(root);
  const attempted = path.resolve(canonicalRoot, requested);
  if (attempted !== canonicalRoot && !attempted.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('preview path escapes its root');
  }
  const candidate = realpathSync(attempted);
  if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
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
    const entry = realpathSync(input.entry);
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
