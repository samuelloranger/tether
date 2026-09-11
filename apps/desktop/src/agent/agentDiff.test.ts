import { describe, expect, test } from 'bun:test';
import { deriveDiff, unifiedLineDiff } from './agentDiff';

describe('unifiedLineDiff', () => {
  test('marks add, del and context', () => {
    const hunks = unifiedLineDiff('a\nb', 'a\nc');
    const kinds = hunks.flatMap((h) => h.lines.map((l) => l.kind));
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('context');
  });

  test('empty old = all adds', () => {
    const hunks = unifiedLineDiff('', 'x\ny');
    expect(hunks[0].lines.every((l) => l.kind === 'add')).toBe(true);
  });

  test('no change = empty', () => {
    expect(unifiedLineDiff('a\nb', 'a\nb')).toEqual([]);
  });
});

describe('deriveDiff', () => {
  test('Edit derives a diff at file_path', () => {
    const d = deriveDiff('Edit', JSON.stringify({ file_path: '/foo', old_string: 'a', new_string: 'b' }));
    expect(d?.path).toBe('/foo');
    expect(d?.hunks[0].lines.some((l) => l.kind === 'del')).toBe(true);
  });

  test('Write derives an all-add diff', () => {
    const d = deriveDiff('Write', JSON.stringify({ file_path: '/new', content: 'x\ny' }));
    expect(d?.path).toBe('/new');
    expect(d?.hunks[0].lines.every((l) => l.kind === 'add')).toBe(true);
  });

  test('non-edit tool has no diff', () => {
    expect(deriveDiff('Bash', JSON.stringify({ command: 'ls' }))).toBeUndefined();
  });
});
