import { afterEach, expect, test } from 'bun:test';
import { app } from './app';
import { resetConfigCache } from './config';
import { db } from './db';
import { registerPushDevice, removePushDevice } from './pushDevices';
import { testAuthHeaders } from './testAuth';

afterEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'config.%'").run();
  resetConfigCache();
});

test('GET and PATCH /api/config are authenticated and merged', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  expect((await app.request('/api/config')).status).toBe(401);
  const patched = await app.request('/api/config', {
    method: 'PATCH',
    headers: AUTH,
    body: JSON.stringify({ push: { enabled: true }, triggers: { exit: false } }),
  });
  expect(patched.status).toBe(200);
  const body = await patched.json();
  expect(body.push).toEqual({ enabled: true });
  expect(body.triggers).toEqual({
    waiting: true,
    done: false,
    oscNotify: true,
    exit: false,
    longJob: true,
  });
  const fetched = await app.request('/api/config', { headers: AUTH });
  expect((await fetched.json()).push.enabled).toBe(true);
});

test('/api/config reports how many devices are registered for push', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  registerPushDevice('config-api-device', Buffer.alloc(32, 3).toString('base64'));
  try {
    const res = await app.request('/api/config', { headers: AUTH });
    // The client needs this to explain silent notifications; it is derived
    // state and must not be patchable.
    expect((await res.json()).pushDevices).toBeGreaterThan(0);
    const rejected = await app.request('/api/config', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ pushDevices: 5 }),
    });
    expect(rejected.status).toBe(400);
  } finally {
    removePushDevice('config-api-device');
  }
});
