import { afterEach, expect, test } from 'bun:test';
import { getConfig, patchConfig, redactConfig, resetConfigCache } from './config';
import { db } from './db';

afterEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'config.%'").run();
  resetConfigCache();
});

test('config defaults and partial patches preserve sibling values', () => {
  expect(getConfig().notify.enabled).toBe(false);
  patchConfig({ notify: { enabled: true, topic: 'alerts', token: 'secret' } });
  const next = patchConfig({ notify: { topic: 'updated' } });
  expect(next.notify).toEqual({
    enabled: true,
    url: 'https://ntfy.sh',
    topic: 'updated',
    token: 'secret',
  });
  expect(redactConfig(next).notify).toEqual({
    enabled: true,
    url: 'https://ntfy.sh',
    topic: 'updated',
    hasToken: true,
  });
});

test('config rejects unknown keys', () => {
  expect(() => patchConfig({ unknown: true })).toThrow();
});
