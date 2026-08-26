import { describe, expect, test } from 'bun:test';
import {
  createDirListingCache,
  entriesToTreeNodes,
  joinDirPath,
  type WorkspaceDirListing,
} from './workspaceDirLogic';

describe('workspaceDirLogic', () => {
  test('joinDirPath nests under parent and keeps root names bare', () => {
    expect(joinDirPath('', 'src')).toBe('src');
    expect(joinDirPath('src', 'lib')).toBe('src/lib');
  });

  test('second expansion of the same directory does not refetch', async () => {
    let calls = 0;
    const listing: WorkspaceDirListing = {
      path: 'src',
      entries: [{ name: 'a.ts', kind: 'file', size: 1 }],
    };
    const cache = createDirListingCache(async () => {
      calls += 1;
      return listing;
    });

    const first = await cache.load('host-1', 'term-1', 'src');
    const second = await cache.load('host-1', 'term-1', 'src');

    expect(calls).toBe(1);
    expect(first).toEqual({
      status: 'ok',
      path: 'src',
      entries: listing.entries,
      truncated: false,
    });
    expect(second).toEqual(first);
  });

  test('surfaces truncated when the server hit the entry cap', async () => {
    const cache = createDirListingCache(async () => ({
      path: 'huge',
      entries: [{ name: 'a', kind: 'file', size: 0 }],
      truncated: true as const,
    }));

    const result = await cache.load('h', 's', 'huge');
    expect(result).toEqual({
      status: 'ok',
      path: 'huge',
      entries: [{ name: 'a', kind: 'file', size: 0 }],
      truncated: true,
    });
  });

  test('error response produces an error state, not an empty directory', async () => {
    const cache = createDirListingCache(async () => {
      throw new Error('waiting for shell to report its working directory');
    });

    const result = await cache.load('h', 's', '');
    expect(result).toEqual({
      status: 'error',
      message: 'waiting for shell to report its working directory',
    });
    expect(result).not.toEqual({
      status: 'ok',
      path: '',
      entries: [],
      truncated: false,
    });
  });

  test('cache keys isolate host and session', async () => {
    const seen: string[] = [];
    const cache = createDirListingCache(async ({ hostId, sessionId, path }) => {
      seen.push(`${hostId}:${sessionId}:${path}`);
      return { path, entries: [] };
    });

    await cache.load('h1', 's1', 'src');
    await cache.load('h2', 's1', 'src');
    await cache.load('h1', 's2', 'src');
    expect(seen).toEqual(['h1:s1:src', 'h2:s1:src', 'h1:s2:src']);
  });

  test('entriesToTreeNodes marks truncated and pending dirs', () => {
    const loaded = new Map([
      [
        'src',
        {
          status: 'ok' as const,
          path: 'src',
          entries: [{ name: 'a.ts', kind: 'file' as const, size: 1 }],
          truncated: true,
        },
      ],
    ]);
    const nodes = entriesToTreeNodes(
      '',
      [
        { name: 'src', kind: 'dir', size: 0 },
        { name: 'README', kind: 'file', size: 2 },
      ],
      loaded,
      new Set(),
      new Map(),
    );
    expect(nodes).toEqual([
      {
        type: 'dir',
        name: 'src',
        path: 'src',
        children: [
          {
            type: 'file',
            name: 'a.ts',
            path: 'src/a.ts',
            file: { path: 'src/a.ts', insertions: 0, deletions: 0, binary: false },
          },
        ],
        browse: { loaded: true, truncated: true },
      },
      {
        type: 'file',
        name: 'README',
        path: 'README',
        file: { path: 'README', insertions: 0, deletions: 0, binary: false },
      },
    ]);
  });
});
