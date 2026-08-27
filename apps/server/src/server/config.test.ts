import { afterEach, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, getConfig, patchConfig, resetConfigCache } from './config';
import { db, setSetting } from './db';

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
    done: false,
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

test('the done trigger is off by default', () => {
  expect(DEFAULT_CONFIG.triggers.done).toBe(false);
});

test('the done trigger can be patched on', async () => {
  const next = await patchConfig({ triggers: { done: true } });
  expect(next.triggers.done).toBe(true);
  expect(next.triggers.waiting).toBe(true);
});

test('a stored row written before done existed keeps the choices it does have', () => {
  // readTopLevel falls back to the WHOLE default block on a parse failure, so a
  // required `done` would silently flip a user's `waiting: false` back on when
  // they upgrade. The zod default is what keeps the old row parseable.
  setSetting(
    'config.triggers',
    JSON.stringify({ waiting: false, oscNotify: true, exit: true, longJob: true }),
  );
  resetConfigCache();
  expect(getConfig().triggers.waiting).toBe(false);
  expect(getConfig().triggers.done).toBe(false);
});
