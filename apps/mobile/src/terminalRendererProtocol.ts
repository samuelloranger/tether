import type { LinkTarget } from './links';

export type RendererTheme = { foreground: string; background: string };

export type RendererCommand =
  | { v: 1; type: 'hydrate'; data: string; cols: number; rows: number; theme: RendererTheme }
  | { v: 1; type: 'write'; data: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'focus' }
  | { v: 1; type: 'dispose' };

export type RendererEvent =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'input'; text: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'openLink'; target: LinkTarget }
  | { v: 1; type: 'selection'; text: string }
  | { v: 1; type: 'rendererFallback'; reason: string };

const positiveInt = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

function linkTarget(value: unknown): value is LinkTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  if (target.kind === 'external') return typeof target.url === 'string';
  if (target.kind !== 'file' || typeof target.path !== 'string') return false;
  if (target.path.startsWith('/') || target.path.split('/').includes('..')) return false;
  return (
    (target.line === undefined || positiveInt(target.line)) &&
    (target.column === undefined || positiveInt(target.column))
  );
}

export function parseRendererEvent(data: string): RendererEvent | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || value.v !== 1) return null;
  switch (value.type) {
    case 'ready':
      return { v: 1, type: 'ready' };
    case 'input':
      return typeof value.text === 'string' ? { v: 1, type: 'input', text: value.text } : null;
    case 'resize':
      return positiveInt(value.cols) && positiveInt(value.rows)
        ? { v: 1, type: 'resize', cols: value.cols, rows: value.rows }
        : null;
    case 'openLink':
      return linkTarget(value.target) ? { v: 1, type: 'openLink', target: value.target } : null;
    case 'selection':
      return typeof value.text === 'string'
        ? { v: 1, type: 'selection', text: value.text }
        : null;
    case 'rendererFallback':
      return typeof value.reason === 'string'
        ? { v: 1, type: 'rendererFallback', reason: value.reason }
        : null;
    default:
      return null;
  }
}

export class RendererQueue {
  private isReady = false;
  private hydrated = false;
  private latestHydrate: Extract<RendererCommand, { type: 'hydrate' }> | null = null;
  private pendingWrites: string[] = [];

  constructor(private send: (command: RendererCommand) => void) {}

  hydrate(data: string, cols: number, rows: number, theme: RendererTheme): void {
    this.latestHydrate = { v: 1, type: 'hydrate', data, cols, rows, theme };
    this.hydrated = false;
    this.flush();
  }

  write(data: string): void {
    if (!data) return;
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'write', data });
    else this.pendingWrites.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'resize', cols, rows });
  }

  focus(): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'focus' });
  }

  ready(): void {
    this.isReady = true;
    this.flush();
  }

  notReady(): void {
    this.isReady = false;
    this.hydrated = false;
  }

  clear(): void {
    this.pendingWrites = [];
  }

  private flush(): void {
    if (!this.isReady || !this.latestHydrate) return;
    if (!this.hydrated) {
      this.send(this.latestHydrate);
      this.hydrated = true;
    }
    for (const data of this.pendingWrites) this.send({ v: 1, type: 'write', data });
    this.pendingWrites = [];
  }
}

export class OutputBatcher {
  private chunks: string[] = [];
  private sessionId: string | null = null;
  private scheduled = false;

  constructor(
    private activeSession: () => string,
    private write: (data: string) => void,
    private schedule: (flush: () => void) => void,
  ) {}

  push(sessionId: string, chunk: string): void {
    if (!chunk || sessionId !== this.activeSession()) return;
    this.sessionId = sessionId;
    this.chunks.push(chunk);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flushNow());
  }

  flushNow(): void {
    this.scheduled = false;
    const data = this.chunks.join('');
    const sessionId = this.sessionId;
    this.chunks = [];
    this.sessionId = null;
    if (data && sessionId === this.activeSession()) this.write(data);
  }

  clear(): void {
    this.chunks = [];
    this.sessionId = null;
  }
}
