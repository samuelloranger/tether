import type { SessionEntry } from '../sessionCache';

export type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any';
export type CursorStyle = 'block' | 'bar' | 'underline';

export type PageSerialize = { data: string; promptLines: number[] };

/** Control / mode updates the page posts when it owns parsing for the active session. */
export type PageControlEvent =
  | { type: 'title'; title: string }
  | { type: 'cwd'; path: string }
  | { type: 'bell' }
  | { type: 'notify'; title: string; body: string }
  | { type: 'promptReturn' }
  | {
      type: 'modes';
      applicationCursor: boolean;
      bracketedPaste: boolean;
      mouseMode: MouseMode;
      mouseSgr: boolean;
      cursorStyle: CursorStyle;
      cursorVisible: boolean;
    };

export type PageControlEffect = 'metadata' | 'notify' | null;

/** Mirror page-owned control state onto the session entry the UI still reads. */
export function applyPageControl(entry: SessionEntry, event: PageControlEvent): PageControlEffect {
  switch (event.type) {
    case 'title':
      if (entry.term.title === event.title) return null;
      entry.term.title = event.title;
      return 'metadata';
    case 'cwd':
      if (entry.term.cwd === event.path) return null;
      entry.term.cwd = event.path;
      return 'metadata';
    case 'bell':
      entry.term.bellCount++;
      return 'notify';
    case 'notify':
      entry.term.lastNotify = { title: event.title, body: event.body };
      entry.term.notifyCount++;
      return 'notify';
    case 'promptReturn':
      entry.term.promptReturnCount++;
      return 'metadata';
    case 'modes':
      entry.term.applicationCursor = event.applicationCursor;
      entry.term.bracketedPaste = event.bracketedPaste;
      entry.term.mouseMode = event.mouseMode;
      entry.term.mouseSgr = event.mouseSgr;
      entry.term.cursorStyle = event.cursorStyle;
      entry.term.cursorVisible = event.cursorVisible;
      return null;
  }
}

export type ShadowTerm = {
  reset(): void;
  write(data: string, onFlush?: () => void): void;
  title?: string;
  cwd?: string;
  bellCount?: number;
  notifyCount?: number;
  lastNotify?: { title: string; body: string };
  promptReturnCount?: number;
  applicationCursor?: boolean;
  bracketedPaste?: boolean;
  mouseMode?: MouseMode;
  mouseSgr?: boolean;
  cursorStyle?: CursorStyle;
  cursorVisible?: boolean;
  restorePromptLines?(lines: number[]): void;
};

type ShadowMeta = {
  title: string;
  cwd: string;
  bellCount: number;
  notifyCount: number;
  lastNotify: { title: string; body: string };
  promptReturnCount: number;
  applicationCursor: boolean;
  bracketedPaste: boolean;
  mouseMode: MouseMode;
  mouseSgr: boolean;
  cursorStyle: CursorStyle;
  cursorVisible: boolean;
};

function readMeta(term: ShadowTerm): ShadowMeta | null {
  if (typeof term.bellCount !== 'number' || typeof term.notifyCount !== 'number') return null;
  return {
    title: term.title ?? '',
    cwd: term.cwd ?? '',
    bellCount: term.bellCount,
    notifyCount: term.notifyCount,
    lastNotify: term.lastNotify ?? { title: '', body: '' },
    promptReturnCount: term.promptReturnCount ?? 0,
    applicationCursor: term.applicationCursor ?? false,
    bracketedPaste: term.bracketedPaste ?? false,
    mouseMode: term.mouseMode ?? 'off',
    mouseSgr: term.mouseSgr ?? false,
    cursorStyle: term.cursorStyle ?? 'block',
    cursorVisible: term.cursorVisible ?? true,
  };
}

function writeMeta(term: ShadowTerm, meta: ShadowMeta): void {
  term.title = meta.title;
  term.cwd = meta.cwd;
  term.bellCount = meta.bellCount;
  term.notifyCount = meta.notifyCount;
  term.lastNotify = meta.lastNotify;
  term.promptReturnCount = meta.promptReturnCount;
  term.applicationCursor = meta.applicationCursor;
  term.bracketedPaste = meta.bracketedPaste;
  term.mouseMode = meta.mouseMode;
  term.mouseSgr = meta.mouseSgr;
  term.cursorStyle = meta.cursorStyle;
  term.cursorVisible = meta.cursorVisible;
}

/** Align notify cursors with the engine so the next background BEL/OSC still fires. */
export function syncNotifyCursors(entry: {
  lastBellCount: number;
  lastNotifyCount: number;
  term: { bellCount: number; notifyCount: number };
}): void {
  entry.lastBellCount = entry.term.bellCount;
  entry.lastNotifyCount = entry.term.notifyCount;
}

export function normalizePageSerialize(
  value: string | PageSerialize | null | undefined,
): PageSerialize {
  if (typeof value === 'string') return { data: value, promptLines: [] };
  if (value && typeof value.data === 'string') {
    return {
      data: value.data,
      promptLines: Array.isArray(value.promptLines)
        ? value.promptLines.filter((n) => Number.isInteger(n) && n >= 0)
        : [],
    };
  }
  return { data: '', promptLines: [] };
}

/** Reset the shadow and seed it with a page serialize plus any bytes that arrived mid-handoff. */
export function seedShadowFromSerialize(
  term: ShadowTerm,
  serialized: string,
  trailingChunks: string[],
  promptLines: number[] = [],
): Promise<void> {
  const meta = readMeta(term);
  term.reset();
  const payload = serialized + trailingChunks.join('');
  return new Promise((resolve) => {
    const finish = () => {
      if (meta) writeMeta(term, meta);
      term.restorePromptLines?.(promptLines);
      resolve();
    };
    if (!payload) {
      finish();
      return;
    }
    term.write(payload, finish);
  });
}

function writeChunks(term: ShadowTerm, chunks: string[]): Promise<void> {
  const payload = chunks.join('');
  return new Promise((resolve) => {
    if (!payload) {
      resolve();
      return;
    }
    term.write(payload, () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize the leaving page (one retry), seed the shadow, then drain any chunks
 * that arrived during the seed — including those that land while a trailing write
 * is still flushing.
 */
export async function completeShadowHandoff(opts: {
  term: ShadowTerm;
  handoff: { chunks: string[] };
  serialize: () => Promise<string | PageSerialize | undefined | null>;
  /** When set, skip the retry if the page is gone after the delay. */
  isAvailable?: () => boolean;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
  /** When set, re-align lastBell/lastNotify after seed so the next edge still fires. */
  entry?: {
    lastBellCount: number;
    lastNotifyCount: number;
    term: { bellCount: number; notifyCount: number };
  };
}): Promise<PageSerialize> {
  const {
    term,
    handoff,
    serialize,
    isAvailable,
    retryDelayMs = 150,
    sleep: wait = sleep,
    warn = console.warn,
    entry,
  } = opts;

  let snapshot: PageSerialize = { data: '', promptLines: [] };
  try {
    snapshot = normalizePageSerialize(await serialize());
  } catch (firstError) {
    await wait(retryDelayMs);
    if (isAvailable && !isAvailable()) {
      warn('shadow handoff: serialize failed; seeding trailing chunks only', firstError);
      snapshot = { data: '', promptLines: [] };
    } else {
      try {
        snapshot = normalizePageSerialize(await serialize());
      } catch (retryError) {
        warn(
          'shadow handoff: serialize failed after retry; seeding trailing chunks only',
          retryError,
        );
        snapshot = { data: '', promptLines: [] };
      }
    }
  }

  const trailingBefore = handoff.chunks.splice(0, handoff.chunks.length);
  await seedShadowFromSerialize(term, snapshot.data, trailingBefore, snapshot.promptLines);
  // Chunks can arrive while the previous write is still parsing — keep draining
  // until a write completes with an empty queue.
  while (handoff.chunks.length > 0) {
    const trailingDuring = handoff.chunks.splice(0, handoff.chunks.length);
    await writeChunks(term, trailingDuring);
  }
  if (entry) syncNotifyCursors(entry);
  return snapshot;
}
