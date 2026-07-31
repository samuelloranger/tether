import { expect, test } from 'bun:test';
import type { SessionEntry } from '../sessionCache';
import {
  applyPageControl,
  completeShadowHandoff,
  type PageControlEvent,
  seedShadowFromSerialize,
  syncNotifyCursors,
} from './pageControlState';

function fakeEntry(): SessionEntry & { writes: string[] } {
  const result = {
    writes: [] as string[],
    term: {
      title: '',
      cwd: '',
      bellCount: 0,
      notifyCount: 0,
      lastNotify: { title: '', body: '' },
      promptReturnCount: 0,
      applicationCursor: false,
      bracketedPaste: false,
      mouseMode: 'off' as const,
      mouseSgr: false,
      cursorStyle: 'block' as const,
      cursorVisible: true,
      restoredPrompts: [] as number[],
      write(data: string, done?: () => void) {
        result.writes.push(data);
        done?.();
      },
      reset() {
        result.writes.push('__reset__');
        result.term.bellCount = 0;
        result.term.notifyCount = 0;
        result.term.title = '';
        result.term.cwd = '';
      },
      restorePromptLines(lines: number[]) {
        result.term.restoredPrompts = [...lines];
      },
    },
    sinceId: 0,
    lastAppliedId: 0,
    diffSummary: { files: [] },
    repoStatus: { branch: '', shortSha: '', detached: false, upstream: null, ahead: 0, behind: 0 },
    lastBellCount: 0,
    lastNotifyCount: 0,
  };
  return result as unknown as SessionEntry & { writes: string[] };
}

test('applyPageControl mirrors title cwd bell notify and modes onto the entry', () => {
  const entry = fakeEntry();
  expect(applyPageControl(entry, { type: 'title', title: 'vim' })).toBe('metadata');
  expect(entry.term.title).toBe('vim');
  expect(applyPageControl(entry, { type: 'cwd', path: '/tmp' })).toBe('metadata');
  expect(entry.term.cwd).toBe('/tmp');
  expect(applyPageControl(entry, { type: 'bell' })).toBe('notify');
  expect(entry.term.bellCount).toBe(1);
  expect(applyPageControl(entry, { type: 'notify', title: 't', body: 'b' })).toBe('notify');
  expect(entry.term.notifyCount).toBe(1);
  expect(entry.term.lastNotify).toEqual({ title: 't', body: 'b' });
  expect(applyPageControl(entry, { type: 'promptReturn' })).toBe('metadata');
  expect(entry.term.promptReturnCount).toBe(1);
  const modes: PageControlEvent = {
    type: 'modes',
    applicationCursor: true,
    bracketedPaste: true,
    mouseMode: 'normal',
    mouseSgr: true,
    cursorStyle: 'bar',
    cursorVisible: false,
  };
  expect(applyPageControl(entry, modes)).toBeNull();
  expect(entry.term.applicationCursor).toBe(true);
  expect(entry.term.bracketedPaste).toBe(true);
  expect(entry.term.mouseMode).toBe('normal');
  expect(entry.term.cursorStyle).toBe('bar');
  expect(entry.term.cursorVisible).toBe(false);
});

test('seedShadowFromSerialize resets then writes serialize plus trailing chunks', async () => {
  const entry = fakeEntry();
  await seedShadowFromSerialize(entry.term, 'BASE', ['a', 'b'], [2, 5]);
  expect(entry.writes).toEqual(['__reset__', 'BASEab']);
  expect((entry.term as { restoredPrompts: number[] }).restoredPrompts).toEqual([2, 5]);
});

test('seedShadowFromSerialize preserves metadata across reset', async () => {
  const entry = fakeEntry();
  entry.term.title = 'vim';
  entry.term.cwd = '/tmp';
  entry.term.bellCount = 3;
  entry.term.notifyCount = 2;
  entry.term.applicationCursor = true;
  await seedShadowFromSerialize(entry.term, 'X', []);
  expect(entry.term.title).toBe('vim');
  expect(entry.term.cwd).toBe('/tmp');
  expect(entry.term.bellCount).toBe(3);
  expect(entry.term.notifyCount).toBe(2);
  expect(entry.term.applicationCursor).toBe(true);
});

test('syncNotifyCursors aligns entry cursors with engine counts', () => {
  const entry = fakeEntry();
  entry.term.bellCount = 2;
  entry.term.notifyCount = 1;
  entry.lastBellCount = 9;
  entry.lastNotifyCount = 9;
  syncNotifyCursors(entry);
  expect(entry.lastBellCount).toBe(2);
  expect(entry.lastNotifyCount).toBe(1);
});

test('completeShadowHandoff seeds snapshot then appends mid-seed trailing in order', async () => {
  const entry = fakeEntry();
  const handoff = { chunks: ['pre'] };
  let seedStarted = false;
  entry.term.write = (data: string, done?: () => void) => {
    entry.writes.push(data);
    if (!seedStarted && data.includes('BASE')) {
      seedStarted = true;
      handoff.chunks.push('mid');
    }
    done?.();
  };
  await completeShadowHandoff({
    term: entry.term,
    handoff,
    serialize: async () => ({ data: 'BASE', promptLines: [1] }),
    sleep: async () => {},
  });
  expect(entry.writes).toEqual(['__reset__', 'BASEpre', 'mid']);
  expect(handoff.chunks).toEqual([]);
  expect((entry.term as { restoredPrompts: number[] }).restoredPrompts).toEqual([1]);
});

test('completeShadowHandoff drains chunks that arrive during the trailing write', async () => {
  const entry = fakeEntry();
  const handoff = { chunks: [] as string[] };
  let writes = 0;
  entry.term.write = (data: string, done?: () => void) => {
    entry.writes.push(data);
    writes++;
    // First write is the seed; second is the mid-seed drain — inject another
    // chunk while that drain write runs so the loop must iterate again.
    if (writes === 1) handoff.chunks.push('mid');
    if (writes === 2) handoff.chunks.push('late');
    done?.();
  };
  await completeShadowHandoff({
    term: entry.term,
    handoff,
    serialize: async () => 'BASE',
    sleep: async () => {},
    entry,
  });
  expect(entry.writes).toEqual(['__reset__', 'BASE', 'mid', 'late']);
  expect(handoff.chunks).toEqual([]);
  expect(entry.lastBellCount).toBe(entry.term.bellCount);
});

test('completeShadowHandoff retries serialize once then falls back to trailing', async () => {
  const entry = fakeEntry();
  const handoff = { chunks: ['kept'] };
  const warnings: unknown[][] = [];
  let attempts = 0;
  await completeShadowHandoff({
    term: entry.term,
    handoff,
    serialize: async () => {
      attempts++;
      throw new Error(`boom-${attempts}`);
    },
    isAvailable: () => true,
    sleep: async () => {},
    warn: (...args) => warnings.push(args),
  });
  expect(attempts).toBe(2);
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0][0])).toContain('after retry');
  expect(entry.writes).toEqual(['__reset__', 'kept']);
});

test('completeShadowHandoff skips retry when page is no longer available', async () => {
  const entry = fakeEntry();
  const handoff = { chunks: ['only'] };
  let attempts = 0;
  await completeShadowHandoff({
    term: entry.term,
    handoff,
    serialize: async () => {
      attempts++;
      throw new Error('disposed');
    },
    isAvailable: () => false,
    sleep: async () => {},
    warn: () => {},
  });
  expect(attempts).toBe(1);
  expect(entry.writes).toEqual(['__reset__', 'only']);
});
