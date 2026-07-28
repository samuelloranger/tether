import { afterEach, expect, test } from 'bun:test';
import {
  getConfig,
  patchConfig,
  redactConfig,
  resetConfigCache,
  validateNotifyUrl,
} from './config';
import { db } from './db';

afterEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'config.%'").run();
  resetConfigCache();
});

test('config defaults and partial patches preserve sibling values', async () => {
  expect(getConfig().notify.enabled).toBe(false);
  await patchConfig({ notify: { enabled: true, topic: 'alerts', token: 'secret' } });
  const next = await patchConfig({ notify: { topic: 'updated' } });
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

test('config rejects unknown keys', async () => {
  await expect(patchConfig({ unknown: true })).rejects.toThrow();
});

test('config rejects a public hostname that resolves to a private notification address', async () => {
  await expect(
    validateNotifyUrl('https://ntfy.example', async () => [{ address: '10.0.0.1' }]),
  ).rejects.toThrow('TETHER_ALLOW_PRIVATE_NOTIFY_URL=1');
});
