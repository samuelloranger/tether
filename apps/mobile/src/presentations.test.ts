import { expect, test } from 'bun:test';
import {
  findSessionPreview,
  type Presentation,
  pickAutoSelectPreview,
  previewUrl,
} from './presentations';

function preview(overrides: Partial<Presentation> = {}): Presentation {
  return {
    id: 'p1',
    title: 'Preview',
    project: 'demo',
    revision: 0,
    url: '/preview/x/index.html',
    ...overrides,
  };
}

test('builds a preview URL from the configured tether server', () => {
  expect(previewUrl('192.168.50.30', '8085', '/preview/capability/index.html')).toBe(
    'http://192.168.50.30:8085/preview/capability/index.html',
  );
});

test('findSessionPreview returns the most recently created preview owned by a session', () => {
  const rows = [
    preview({ id: 'p1', sessionId: 'term-1' }),
    preview({ id: 'p2', sessionId: 'term-2' }),
    preview({ id: 'p3', sessionId: 'term-1' }),
  ];
  expect(findSessionPreview(rows, 'term-1')?.id).toBe('p3');
  expect(findSessionPreview(rows, 'term-2')?.id).toBe('p2');
  expect(findSessionPreview(rows, 'term-9')).toBeNull();
});

test('pickAutoSelectPreview only returns a preview new to `seen` and owned by the active session', () => {
  const rows = [
    preview({ id: 'p1', sessionId: 'term-1' }),
    preview({ id: 'p2', sessionId: 'term-2' }),
  ];
  expect(pickAutoSelectPreview(rows, new Set(), 'term-1')?.id).toBe('p1');
  expect(pickAutoSelectPreview(rows, new Set(), 'term-2')?.id).toBe('p2');
  expect(pickAutoSelectPreview(rows, new Set(['p1']), 'term-1')).toBeNull();
  expect(pickAutoSelectPreview(rows, new Set(), 'term-3')).toBeNull();
});
