// Run: bun run src/sessionCache.test.ts   (from apps/mobile)
import { SessionCache, nextTermId, type SessionEntry } from './sessionCache';

let pass = 0;
function ok(c: boolean, m: string) {
  if (!c) throw new Error(`FAIL ${m}`);
  pass++;
}
const mk = (tag: string): (() => SessionEntry) => () =>
  ({ term: { tag } as any, sinceId: 0, lastAppliedId: 0 } as any);

// touch creates and is retrievable
{
  const c = new SessionCache(3);
  const e = c.touch('term-1', mk('1'));
  ok(c.get('term-1') === e, 'touch stores entry');
  ok(c.has('term-1'), 'has returns true');
}

// LRU evicts least-recently-touched beyond cap
{
  const c = new SessionCache(2);
  c.touch('a', mk('a'));
  c.touch('b', mk('b'));
  c.touch('a', mk('a2')); // a becomes most-recent; make ignored (already present)
  c.touch('c', mk('c')); // evicts b (least recent)
  ok(c.has('a'), 'a retained (recently touched)');
  ok(c.has('c'), 'c retained (newest)');
  ok(!c.has('b'), 'b evicted');
  ok((c.get('a')!.term as any).tag === 'a', 'existing entry not rebuilt on re-touch');
}

// delete removes
{
  const c = new SessionCache(3);
  c.touch('x', mk('x'));
  c.delete('x');
  ok(!c.has('x'), 'delete removes');
}

// nextTermId picks max+1 (handles gaps and non-matching ids)
{
  ok(nextTermId([]) === 'term-1', 'empty -> term-1');
  ok(nextTermId(['term-1', 'term-3']) === 'term-4', 'gap -> max+1');
  ok(nextTermId(['default', 'term-2']) === 'term-3', 'ignores non-term ids');
}

console.log(`\n  ${pass} assertions passed\n`);
