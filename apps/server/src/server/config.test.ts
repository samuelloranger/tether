import { afterEach, expect, test } from 'bun:test';
import {
  DEFAULT_CONFIG,
  getConfig,
  getShellSupport,
  patchConfig,
  resetConfigCache,
} from './config';
import { db, setSetting } from './db';
import { describeShellSupport } from './ptyShell';

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
  // Servers upgrading from before native push still have `config.notify` stored;
  // getConfig must treat the leftover row as inert, not a strict-parse failure.
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

test('the exit trigger is off by default', () => {
  // A tab you closed (or a shell that exited while looking) isn't a reason to
  // wake the phone; users who want that can still turn it on.
  expect(DEFAULT_CONFIG.triggers.exit).toBe(false);
});

test('the done trigger can be patched on', async () => {
  const next = await patchConfig({ triggers: { done: true } });
  expect(next.triggers.done).toBe(true);
  expect(next.triggers.waiting).toBe(true);
});

test('a stored row written before done existed keeps the choices it does have', () => {
  // readTopLevel falls back to the WHOLE default block on parse failure, so a
  // required `done` would silently flip `waiting: false` back on; the zod default avoids that.
  setSetting(
    'config.triggers',
    JSON.stringify({ waiting: false, oscNotify: true, exit: true, longJob: true }),
  );
  resetConfigCache();
  expect(getConfig().triggers.waiting).toBe(false);
  expect(getConfig().triggers.done).toBe(false);
});

// defaultShell is free text; an MSYS/Git-for-Windows bash silently disables git,
// file-tree and upload — still accepted, so the shell report is what surfaces the cost.
test('the shell report follows the configured default shell', async () => {
  expect(getShellSupport().shell).toBe(
    describeShellSupport(DEFAULT_CONFIG.session.defaultShell).shell,
  );
  await patchConfig({ session: { defaultShell: 'nu' } });
  expect(getShellSupport().shell).toBe('nu');
});

test('a known-broken shell is accepted, but reported as broken', async () => {
  const next = await patchConfig({ session: { defaultShell: 'bash.exe' } });
  expect(next.session.defaultShell).toBe('bash.exe');
  const support = describeShellSupport('bash.exe', true);
  expect(support.integration).toBe('broken');
  expect(support.reason).toContain('/c/Users/you');
});

test('the shell report is not a config key and cannot be patched', async () => {
  await expect(patchConfig({ session: { shellSupport: 'full' } })).rejects.toThrow();
});
