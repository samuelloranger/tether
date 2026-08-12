import { afterEach, expect, test } from 'bun:test';
import { getConfig, patchConfig, resetConfigCache } from './config';
import { db } from './db';

afterEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'config.%'").run();
  resetConfigCache();
});

test('config defaults and partial patches preserve sibling values', async () => {
  expect(getConfig().push.enabled).toBe(false);
  await patchConfig({ push: { enabled: true }, triggers: { waiting: false } });
  const next = await patchConfig({ triggers: { exit: false } });
  expect(next.push.enabled).toBe(true);
  expect(next.triggers).toEqual({
    waiting: false,
    oscNotify: true,
    exit: false,
    longJob: true,
  });
});

test('config rejects unknown keys', async () => {
  await expect(patchConfig({ unknown: true })).rejects.toThrow();
});

test('a settings row left by a removed section does not break config reads', () => {
  // Servers upgrading from before native push still have `config.notify`
  // stored. getConfig reads only the keys it knows, so the leftover row must
  // be inert rather than a strict-parse failure that takes the server down.
  db.query('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)').run({
    $key: 'config.notify',
    $value: JSON.stringify({ enabled: true, url: 'https://ntfy.sh', topic: 'old' }),
  });
  resetConfigCache();
  expect(() => getConfig()).not.toThrow();
  expect(getConfig().push.enabled).toBe(false);
});
