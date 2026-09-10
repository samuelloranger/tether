import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listClaudeSessions, slugForCwd } from './claudeSessions';

test('slugForCwd maps slashes to dashes', () => {
  expect(slugForCwd('/home/sam/sites/tether')).toBe('-home-sam-sites-tether');
});

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-'));
  const proj = join(root, slugForCwd('/work/repo'));
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, '11111111-aaaa-bbbb-cccc-000000000001.jsonl'),
    [
      JSON.stringify({ type: 'last-prompt', leafUuid: 'u1' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'fix the socket' },
        uuid: 'u1',
      }),
    ].join('\n'),
  );
});

test('listClaudeSessions returns meta with a label', () => {
  const out = listClaudeSessions('/work/repo', { projectsDir: root });
  expect(out.length).toBe(1);
  expect(out[0].id).toBe('11111111-aaaa-bbbb-cccc-000000000001');
  expect(out[0].label).toContain('fix the socket');
  expect(out[0].msgCount).toBeGreaterThan(0);
});

test('missing project dir → empty list, no throw', () => {
  expect(listClaudeSessions('/nope', { projectsDir: root })).toEqual([]);
});
