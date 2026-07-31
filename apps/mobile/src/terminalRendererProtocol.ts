import type { LinkTarget } from './links';
import type { CursorStyle, MouseMode, PageControlEvent } from './tether/pageControlState';

export type RendererTheme = {
  foreground: string;
  background: string;
  keyboardAppearance: 'light' | 'dark';
};

export type RendererCommand =
  | {
      v: 1;
      type: 'hydrate';
      data: string;
      cols: number;
      rows: number;
      theme: RendererTheme;
      fontFamily: string;
      fontSize: number;
      promptLines?: number[];
    }
  | { v: 1; type: 'write'; data: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'scroll'; line: number }
  | { v: 1; type: 'selectAll' }
  | { v: 1; type: 'focus' }
  | { v: 1; type: 'blur' }
  | { v: 1; type: 'serialize'; requestId: string }
  | { v: 1; type: 'snapshotText'; requestId: string }
  | { v: 1; type: 'jumpPrompt'; dir: 1 | -1 };

export type RendererControlEvent = { v: 1 } & PageControlEvent;

export type RendererEvent =
  | { v: 1; type: 'ready' }
  // Answer to the liveness probe. Not emitted by the renderer bundle — the
  // native side injects the postMessage, gated on the renderer's own global, so
  // a pong proves the content process is up AND still running our page.
  | { v: 1; type: 'pong' }
  | { v: 1; type: 'input'; text: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'openLink'; target: LinkTarget }
  | { v: 1; type: 'selection'; text: string }
  | { v: 1; type: 'rendererFallback'; reason: string }
  | RendererControlEvent
  | { v: 1; type: 'reply'; data: string }
  | { v: 1; type: 'clipboardWrite'; text: string }
  | { v: 1; type: 'serialized'; requestId: string; data: string; promptLines: number[] }
  | { v: 1; type: 'snapshotText'; requestId: string; text: string }
  | { v: 1; type: 'hydrated' };

const MOUSE_MODES = new Set<MouseMode>(['off', 'x10', 'normal', 'button', 'any']);
const CURSOR_STYLES = new Set<CursorStyle>(['block', 'bar', 'underline']);

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
    case 'pong':
      return { v: 1, type: 'pong' };
    case 'input':
      return typeof value.text === 'string' ? { v: 1, type: 'input', text: value.text } : null;
    case 'resize':
      return positiveInt(value.cols) && positiveInt(value.rows)
        ? { v: 1, type: 'resize', cols: value.cols, rows: value.rows }
        : null;
    case 'openLink':
      return linkTarget(value.target) ? { v: 1, type: 'openLink', target: value.target } : null;
    case 'selection':
      return typeof value.text === 'string' ? { v: 1, type: 'selection', text: value.text } : null;
    case 'rendererFallback':
      return typeof value.reason === 'string'
        ? { v: 1, type: 'rendererFallback', reason: value.reason }
        : null;
    case 'title':
      return typeof value.title === 'string' ? { v: 1, type: 'title', title: value.title } : null;
    case 'cwd':
      return typeof value.path === 'string' ? { v: 1, type: 'cwd', path: value.path } : null;
    case 'bell':
      return { v: 1, type: 'bell' };
    case 'notify':
      return typeof value.title === 'string' && typeof value.body === 'string'
        ? { v: 1, type: 'notify', title: value.title, body: value.body }
        : null;
    case 'promptReturn':
      return { v: 1, type: 'promptReturn' };
    case 'modes': {
      const mouseMode = value.mouseMode;
      const cursorStyle = value.cursorStyle;
      if (
        typeof value.applicationCursor !== 'boolean' ||
        typeof value.bracketedPaste !== 'boolean' ||
        typeof value.mouseSgr !== 'boolean' ||
        typeof value.cursorVisible !== 'boolean' ||
        typeof mouseMode !== 'string' ||
        !MOUSE_MODES.has(mouseMode as MouseMode) ||
        typeof cursorStyle !== 'string' ||
        !CURSOR_STYLES.has(cursorStyle as CursorStyle)
      )
        return null;
      return {
        v: 1,
        type: 'modes',
        applicationCursor: value.applicationCursor,
        bracketedPaste: value.bracketedPaste,
        mouseMode: mouseMode as MouseMode,
        mouseSgr: value.mouseSgr,
        cursorStyle: cursorStyle as CursorStyle,
        cursorVisible: value.cursorVisible,
      };
    }
    case 'reply':
      return typeof value.data === 'string' ? { v: 1, type: 'reply', data: value.data } : null;
    case 'clipboardWrite':
      return typeof value.text === 'string'
        ? { v: 1, type: 'clipboardWrite', text: value.text }
        : null;
    case 'serialized': {
      if (typeof value.requestId !== 'string' || typeof value.data !== 'string') return null;
      const promptLines = Array.isArray(value.promptLines)
        ? value.promptLines.filter(
            (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0,
          )
        : [];
      return {
        v: 1,
        type: 'serialized',
        requestId: value.requestId,
        data: value.data,
        promptLines,
      };
    }
    case 'snapshotText':
      return typeof value.requestId === 'string' && typeof value.text === 'string'
        ? { v: 1, type: 'snapshotText', requestId: value.requestId, text: value.text }
        : null;
    case 'hydrated':
      return { v: 1, type: 'hydrated' };
    default:
      return null;
  }
}

/** Correlate serialize / snapshotText requests with page responses. */
export class RendererRpc {
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;

  constructor(
    private send: (command: RendererCommand) => void,
    private timeoutMs = 3000,
  ) {}

  requestSerialize(): Promise<import('./tether/pageControlState').PageSerialize> {
    return this.request('serialize') as Promise<import('./tether/pageControlState').PageSerialize>;
  }

  requestSnapshotText(): Promise<string> {
    return this.request('snapshotText') as Promise<string>;
  }

  /** @deprecated prefer requestSerialize / requestSnapshotText */
  request(type: 'serialize' | 'snapshotText'): Promise<unknown> {
    const requestId = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ v: 1, type, requestId });
    });
  }

  settle(requestId: string, data: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(data);
  }

  clear(reason = 'cleared'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

export class RendererQueue {
  private isReady = false;
  private hydrated = false;
  private latestHydrate: Extract<RendererCommand, { type: 'hydrate' }> | null = null;
  private pendingWrites: string[] = [];

  constructor(private send: (command: RendererCommand) => void) {}

  hydrate(
    data: string,
    cols: number,
    rows: number,
    theme: RendererTheme,
    fontFamily: string,
    fontSize: number,
    promptLines: number[] = [],
  ): void {
    if (this.latestHydrate) this.pendingWrites = [];
    this.latestHydrate = {
      v: 1,
      type: 'hydrate',
      data,
      cols,
      rows,
      theme,
      // The page carries the same TTFs the app bundles (see the @font-face block
      // in terminalRendererHtml), so the user's pick applies on native too. The
      // system stack stays as a fallback for the first frames before the data
      // URI font decodes.
      fontFamily: `"${fontFamily}", ui-monospace, "SFMono-Regular", Menlo, monospace`,
      fontSize,
      promptLines,
    };
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

  scrollToLine(line: number): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'scroll', line });
  }

  selectAll(): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'selectAll' });
  }

  focus(): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'focus' });
  }

  blur(): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'blur' });
  }

  serialize(requestId: string): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'serialize', requestId });
  }

  snapshotText(requestId: string): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'snapshotText', requestId });
  }

  jumpPrompt(dir: 1 | -1): void {
    if (this.isReady && this.hydrated) this.send({ v: 1, type: 'jumpPrompt', dir });
  }

  ready(): void {
    this.isReady = true;
    this.flush();
  }

  notReady(): void {
    this.isReady = false;
    this.hydrated = false;
  }

  recover(rehydrate: () => void): void {
    this.notReady();
    rehydrate();
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
  private generation = 0;

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
    const generation = this.generation;
    this.schedule(() => {
      if (generation === this.generation) this.flushNow();
    });
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
    this.generation += 1;
    this.scheduled = false;
    this.chunks = [];
    this.sessionId = null;
  }
}
