import { expect, test } from 'bun:test';
import { SessionCache, type SessionEntry } from './sessionCache';

const mk =
  (tag: string): (() => SessionEntry) =>
  () =>
    ({ term: { tag } as any, sinceId: 0, lastAppliedId: 0, diffSummary: { files: [] } }) as any;

test('peek does not reorder the LRU or evict', () => {
  const evicted: string[] = [];
  const c = new SessionCache(2, (id) => evicted.push(id));
  c.touch('a', mk('a'));
  c.touch('b', mk('b'));
  c.peek('a'); // must NOT make 'a' most-recent
  c.touch('c', mk('c')); // over cap -> evicts LRU ('a' if peek didn't reorder)
  expect(evicted).toEqual(['a']);
});

test('cap is clamped to at least 1', () => {
  const c = new SessionCache(0, () => {});
  c.touch('only', mk('only'));
  expect(c.has('only')).toBe(true); // must not evict the entry it just created
});
