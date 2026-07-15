import { expect, test } from 'bun:test';
import config from '../src-tauri/tauri.conf.json';

test('does not identify every desktop platform as macOS', () => {
  expect(config.app.windows[0]).not.toHaveProperty('userAgent');
});
