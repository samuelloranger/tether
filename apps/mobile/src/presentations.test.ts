import { expect, test } from 'bun:test';
import { previewUrl } from './presentations';

test('builds a preview URL from the configured tether server', () => {
  expect(previewUrl('192.168.50.30', '8085', '/preview/capability/index.html')).toBe(
    'http://192.168.50.30:8085/preview/capability/index.html',
  );
});
