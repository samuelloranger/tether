import { expect, mock, test } from 'bun:test';
import type { ReviewDiffSlot } from '../fetchReviewDiff';
import type { SessionEntry } from '../sessionCache';
import type { HostClient } from './hostClient';

// gitReviewActions pulls in AsyncStorage and ../dialog (which imports
// react-native, whose Flow syntax Bun's parser can't handle) — mock both, as
// dialog.test.ts does, so the module under test can be imported at all.
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Alert: { alert: () => {} },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));

const { retryReviewFile } = await import('./gitReviewActions');

function harness(paths: string[]) {
  const slots: Array<Record<string, ReviewDiffSlot>> = [];
  const requested: string[] = [];
  let state: Record<string, ReviewDiffSlot> = {};

  const mutators = {
    setReviewDiffs: (update: unknown) => {
      state =
        typeof update === 'function'
          ? (update as (p: typeof state) => typeof state)(state)
          : (update as typeof state);
      slots.push(state);
    },
    reviewLoadGenRef: { current: 0 },
  };

  const client = {
    get: async (path: string) => {
      requested.push(path);
      return new Response(JSON.stringify({ diff: 'diff --git a/a b/a', truncated: false }));
    },
  } as unknown as HostClient;

  const entry = {
    diffSummary: { files: paths.map((path) => ({ path, binary: false })) },
  } as unknown as SessionEntry;

  return {
    slots,
    requested,
    retry: (path: string) =>
      retryReviewFile(
        mutators as unknown as Parameters<typeof retryReviewFile>[0],
        client,
        'term-1',
        entry,
        'unstaged',
        path,
      ),
  };
}

test('retryReviewFile shows the spinner and fills the slot for a known path', async () => {
  const h = harness(['src/a.ts']);
  h.retry('src/a.ts');
  expect(h.slots[0]?.['unstaged:src/a.ts']).toEqual({ status: 'loading' });
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.slots.at(-1)?.['unstaged:src/a.ts']).toEqual({
    status: 'ready',
    text: 'diff --git a/a b/a',
    truncated: false,
  });
});

// Regression: the loading slot used to be set before the file-existence check
// (which moved into retryOneReviewDiff and returns null), so retrying a path
// that had since dropped out of the summary spun forever instead of no-opping.
test('retryReviewFile leaves no spinner for a path missing from the summary', async () => {
  const h = harness(['src/a.ts']);
  h.retry('src/gone.ts');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.slots).toEqual([]);
  expect(h.requested).toEqual([]);
});
