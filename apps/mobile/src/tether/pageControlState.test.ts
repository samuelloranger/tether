import { expect, test } from 'bun:test';
import type { SessionEntry } from '../sessionCache';
import {
  applyPageControl,
  completeShadowHandoff,
  type PageControlEvent,
  seedShadowFromSerialize,
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
      write(data: string, done?: () => void) {
        result.writes.push(data);
        done?.();
      },
      reset() {
        result.writes.push('__reset__');
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
  await seedShadowFromSerialize(entry.term, 'BASE', ['a', 'b']);
  expect(entry.writes).toEqual(['__reset__', 'BASEab']);
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
    serialize: async () => 'BASE',
    sleep: async () => {},
  });
  expect(entry.writes).toEqual(['__reset__', 'BASEpre', 'mid']);
  expect(handoff.chunks).toEqual([]);
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
