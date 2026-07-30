import { expect, test } from 'bun:test';
import type { DiffFileStat } from './diffModel';
import { fetchOneReviewDiff, reviewDiffRequestPath } from './fetchReviewDiff';
import type { HostClient, HostClientResponse } from './tether/hostClient';

function fakeClient(handler: (path: string) => HostClientResponse): HostClient {
  return {
    profile: {
      id: 'h',
      name: 'H',
      color: '#000',
      host: 'localhost',
      port: '8085',
      identityName: 'h',
      order: 0,
    },
    baseUrl: 'http://localhost:8085',
    authHeader: {},
    url: (path) => `http://localhost:8085${path}`,
    get: async (path) => handler(path),
    post: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      blob: async () => new Blob(),
    }),
    openSocket: () => {
      throw new Error('unused');
    },
    loadIdentity: async () => ({ name: 'H', color: '#000' }),
  };
}

test('reviewDiffRequestPath encodes mode for text and side for images', () => {
  expect(reviewDiffRequestPath('s1', 'a.ts', 'staged', 'text')).toBe(
    '/api/sessions/s1/diff?path=a.ts&mode=staged',
  );
  expect(reviewDiffRequestPath('s1', 'a.ts', 'unstaged', 'text')).toBe(
    '/api/sessions/s1/diff?path=a.ts&mode=unstaged',
  );
  expect(reviewDiffRequestPath('s1', 'x.png', 'unstaged', 'image-old')).toBe(
    '/api/sessions/s1/diff/file?path=x.png&side=old',
  );
  expect(reviewDiffRequestPath('s1', 'x.png', 'unstaged', 'image-new')).toBe(
    '/api/sessions/s1/diff/file?path=x.png&side=new',
  );
});

test('fetchOneReviewDiff returns ready text with the mode query', async () => {
  const seen: string[] = [];
  const file: DiffFileStat = {
    path: 'a.ts',
    insertions: 1,
    deletions: 0,
    binary: false,
    staged: true,
  };
  const client = fakeClient((path) => {
    seen.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => ({ diff: '@@\n+hi', truncated: false }),
      blob: async () => new Blob(),
    };
  });
  const slot = await fetchOneReviewDiff({
    client,
    sessionId: 'sess',
    path: 'a.ts',
    mode: 'staged',
    file,
  });
  expect(seen).toEqual(['/api/sessions/sess/diff?path=a.ts&mode=staged']);
  expect(slot).toEqual({ status: 'ready', text: '@@\n+hi', truncated: false });
});

test('fetchOneReviewDiff returns error slots on failure', async () => {
  const file: DiffFileStat = {
    path: 'a.ts',
    insertions: 1,
    deletions: 0,
    binary: false,
    staged: false,
  };
  const client = fakeClient(() => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'boom' }),
    blob: async () => new Blob(),
  }));
  const slot = await fetchOneReviewDiff({
    client,
    sessionId: 'sess',
    path: 'a.ts',
    mode: 'unstaged',
    file,
  });
  expect(slot.status).toBe('error');
  if (slot.status === 'error') expect(slot.message).toContain('boom');
});
