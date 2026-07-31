import type { SessionEntry } from '../sessionCache';

export type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any';
export type CursorStyle = 'block' | 'bar' | 'underline';

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

type ShadowTerm = { reset(): void; write(data: string, onFlush?: () => void): void };

/** Reset the shadow and seed it with a page serialize plus any bytes that arrived mid-handoff. */
export function seedShadowFromSerialize(
  term: ShadowTerm,
  serialized: string,
  trailingChunks: string[],
): Promise<void> {
  term.reset();
  const payload = serialized + trailingChunks.join('');
  return new Promise((resolve) => {
    if (!payload) {
      resolve();
      return;
    }
    term.write(payload, () => resolve());
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
 * Serialize the leaving page (one retry), seed the shadow, then append any chunks
 * that arrived during the seed. Caller keeps handoff.chunks live until this resolves
 * so mid-seed output is captured rather than lost to the active-page path.
 */
export async function completeShadowHandoff(opts: {
  term: ShadowTerm;
  handoff: { chunks: string[] };
  serialize: () => Promise<string | undefined | null>;
  /** When set, skip the retry if the page is gone after the delay. */
  isAvailable?: () => boolean;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
}): Promise<void> {
  const {
    term,
    handoff,
    serialize,
    isAvailable,
    retryDelayMs = 150,
    sleep: wait = sleep,
    warn = console.warn,
  } = opts;

  let serialized = '';
  try {
    serialized = (await serialize()) ?? '';
  } catch (firstError) {
    await wait(retryDelayMs);
    if (isAvailable && !isAvailable()) {
      warn('shadow handoff: serialize failed; seeding trailing chunks only', firstError);
      serialized = '';
    } else {
      try {
        serialized = (await serialize()) ?? '';
      } catch (retryError) {
        warn(
          'shadow handoff: serialize failed after retry; seeding trailing chunks only',
          retryError,
        );
        serialized = '';
      }
    }
  }

  const trailingBefore = handoff.chunks.splice(0, handoff.chunks.length);
  await seedShadowFromSerialize(term, serialized, trailingBefore);
  const trailingDuring = handoff.chunks.splice(0, handoff.chunks.length);
  await writeChunks(term, trailingDuring);
}
