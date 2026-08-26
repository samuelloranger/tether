import { describe, expect, test } from 'bun:test';
import {
  findSessionPreview,
  lineOffset,
  pickAutoSelectPreview,
  previewUrl,
  shellQuote,
} from './workspaceTypes';

describe('workspaceTypes', () => {
  test('shellQuote and lineOffset', () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    expect(lineOffset('a\nb\nc', 2)).toBe(1);
    expect(lineOffset('a\nb\nc', 99)).toBe(2);
  });

  test('presentation helpers', () => {
    const rows = [
      {
        id: '1',
        title: 'a',
        project: 'p',
        revision: 0,
        url: '/preview/t/a.html',
        sessionId: 'term-1',
      },
      {
        id: '2',
        title: 'b',
        project: 'p',
        revision: 1,
        url: '/preview/t/b.html',
        sessionId: 'term-1',
      },
    ];
    expect(findSessionPreview(rows, 'term-1')?.id).toBe('2');
    expect(pickAutoSelectPreview(rows, new Set(['1']), 'term-1')?.id).toBe('2');
    expect(previewUrl('http://h:8085', '/preview/t/a.html')).toBe('http://h:8085/preview/t/a.html');
  });
});
