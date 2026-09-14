import { randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';
import { canonicalPath } from '@/workspace/file';
import { inlinePresentation } from './inline';

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  sessionId?: string;
}

interface InternalPresentation extends Presentation {
  entry: string;
  content: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
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
    const entry = canonicalPath(input.entry);
    if (path.extname(entry).toLowerCase() !== '.html')
      throw new Error('preview entry must be an HTML file');
    const root = path.dirname(entry);
    const preview: InternalPresentation = {
      id: randomUUID(),
      title: input.title || path.basename(entry, path.extname(entry)),
      project: input.project || path.basename(root),
      revision: 0,
      sessionId: input.sessionId,
      entry,
      content: inlinePresentation(entry),
      watcher: undefined as unknown as FSWatcher,
      timer: null,
    };
    // Watch the whole root, not just the entry: an inlined asset changing must
    // regenerate the self-contained HTML too.
    preview.watcher = watch(root, { recursive: true }, () => this.bump(preview));
    this.previews.set(preview.id, preview);
    return this.public(preview);
  }

  list(): Presentation[] {
    return [...this.previews.values()].map((preview) => this.public(preview));
  }

  // The self-contained HTML for a preview, fetched over the authed content route.
  // Nothing is served by URL; the bytes travel on the bearer channel only.
  content(id: string): string | null {
    return this.previews.get(id)?.content ?? null;
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

  dispose(): void {
    this.reset();
  }

  private bump(preview: InternalPresentation): void {
    if (preview.timer) clearTimeout(preview.timer);
    preview.timer = setTimeout(() => {
      preview.timer = null;
      if (!this.previews.has(preview.id)) return;
      preview.revision++;
      try {
        preview.content = inlinePresentation(preview.entry);
      } catch {
        // Mid-write or transiently missing asset: keep the last good content.
      }
    }, this.debounceMs);
  }

  private public(preview: InternalPresentation): Presentation {
    return {
      id: preview.id,
      title: preview.title,
      project: preview.project,
      revision: preview.revision,
      sessionId: preview.sessionId,
    };
  }
}
