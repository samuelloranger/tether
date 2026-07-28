import { expect, test } from 'bun:test';
import { createHostClient, type HostClientResponse } from './hostClient';
import type { HostProfile } from './hostStore';

const profile: HostProfile = {
  id: 'host-1',
  name: 'Studio Mac',
  color: '#89b4fa',
  host: 'studio.local',
  port: '8085',
  identityName: 'studio',
  order: 0,
};

test('builds HTTP and WebSocket URLs without putting the password in either URL', () => {
  const socketUrls: string[] = [];
  const client = createHostClient(profile, 'not-in-a-url', {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      blob: async () => new Blob(),
    }),
    openSocket: (url) => {
      socketUrls.push(url);
      return {} as never;
    },
  });

  expect(client.url('/api/sessions?status=running')).toBe(
    'http://studio.local:8085/api/sessions?status=running',
  );
  client.openSocket('/api/ws', { sessionId: 'term-1', sinceId: 2 });
  expect(socketUrls).toEqual(['ws://studio.local:8085/api/ws?sessionId=term-1&sinceId=2']);
  expect([...socketUrls, client.url('/api/sessions')].join(' ')).not.toContain('not-in-a-url');
});

test('adds the host authorization header to get, post, and identity requests', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const response: HostClientResponse = {
    ok: true,
    status: 200,
    json: async () => ({ identity: { name: 'Studio', color: '#cba6f7' } }),
    blob: async () => new Blob(),
  };
  const client = createHostClient(profile, 'secret', {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response;
    },
    openSocket: () => ({}) as never,
  });

  await client.get('/api/sessions');
  await client.post('/api/rename', { method: 'POST', body: JSON.stringify({ name: 'new' }) });
  await expect(client.loadIdentity()).resolves.toEqual({ name: 'Studio', color: '#cba6f7' });

  expect(requests).toHaveLength(3);
  for (const request of requests)
    expect(new Headers(request.init?.headers).get('Authorization')).toBe('Bearer secret');
  expect(requests[1]?.init?.method).toBe('POST');
});
