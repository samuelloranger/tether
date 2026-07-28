import { expect, test } from 'bun:test';
import {
  changeServerPassword,
  loadServerConfig,
  patchServerConfig,
  sendServerNotificationTest,
} from './serverConfig';

function client() {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  return {
    requests,
    value: {
      get: async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return { ok: true, status: 200, json: async () => ({ identity: { name: 'Studio' } }) };
      },
      post: async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
  };
}

test('uses HostClient request bodies for config and privileged operations without password URLs', async () => {
  const mocked = client();
  await loadServerConfig(mocked.value as never);
  await patchServerConfig(mocked.value as never, { identity: { name: 'Studio Mac' } });
  await sendServerNotificationTest(mocked.value as never, { notify: { topic: 'test' } });
  await changeServerPassword(mocked.value as never, 'current-password', 'next-password');

  expect(mocked.requests.map(({ path }) => path)).toEqual([
    '/api/config',
    '/api/config',
    '/api/admin/test-notification',
    '/api/admin/password',
  ]);
  expect(mocked.requests[1]?.init?.method).toBe('PATCH');
  expect(mocked.requests[3]?.init?.body).toBe(
    JSON.stringify({ current: 'current-password', next: 'next-password' }),
  );
  expect(mocked.requests.map(({ path }) => path).join(' ')).not.toContain('current-password');
});
