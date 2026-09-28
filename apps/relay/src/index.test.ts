import { beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from './index';
import { fakeEnv, generateP8, limiter } from './testing';

const TOKEN = 'a'.repeat(64);
let pem = '';

beforeAll(async () => {
  pem = (await generateP8()).pem;
});

interface Sent {
  url: string;
  init: RequestInit;
}

function apnsStub(respond: (url: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return respond(String(url));
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function push(env: Env, fetchImpl: typeof fetch, body: unknown, ip = '203.0.113.7') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip) headers['cf-connecting-ip'] = ip;
  return createApp(fetchImpl).request(
    '/push',
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    env,
  );
}

const ok = () => new Response(null, { status: 200 });
const cleartext = { token: TOKEN, title: 'Session idle', body: 'Waiting for input' };

describe('POST /push', () => {
  test('forwards to APNs with the topic and a bearer JWT', async () => {
    const { sent, fetchImpl } = apnsStub(ok);
    const res = await push(fakeEnv(pem), fetchImpl, { ...cleartext, collapseId: 's-1' });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-collapse-id']).toBe('s-1');
    expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('sends ciphertext for the extension to decrypt, with a placeholder alert', async () => {
    const { sent, fetchImpl } = apnsStub(ok);
    await push(fakeEnv(pem), fetchImpl, { token: TOKEN, ciphertext: 'c2VjcmV0' });
    const payload = JSON.parse(String(sent[0]?.init.body));
    expect(payload.e).toBe('c2VjcmV0');
    expect(payload.aps['mutable-content']).toBe(1);
  });

  test('retries a BadDeviceToken once on the other environment', async () => {
    const { sent, fetchImpl } = apnsStub((url) =>
      url.startsWith('https://api.push.apple.com')
        ? new Response('{"reason":"BadDeviceToken"}', { status: 400 })
        : ok(),
    );
    const res = await push(fakeEnv(pem), fetchImpl, cleartext);
    expect(res.status).toBe(200);
    expect(sent.map((s) => new URL(s.url).host)).toEqual(['api.push.apple.com', 'api.sandbox.push.apple.com']);
  });

  test('tries sandbox first when configured', async () => {
    const { sent, fetchImpl } = apnsStub(ok);
    await push(fakeEnv(pem, { APNS_ENV: 'sandbox' }), fetchImpl, cleartext);
    expect(new URL(sent[0]?.url ?? '').host).toBe('api.sandbox.push.apple.com');
  });

  test("refuses a request that didn't come through the edge", async () => {
    const { sent, fetchImpl } = apnsStub(ok);
    expect((await push(fakeEnv(pem), fetchImpl, cleartext, '')).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('limits per client IP before reading the body', async () => {
    const perIp = limiter(false);
    const { sent, fetchImpl } = apnsStub(ok);
    const res = await push(fakeEnv(pem, { PER_IP: perIp }), fetchImpl, 'not json');
    expect(res.status).toBe(429);
    expect(perIp.keys).toEqual(['203.0.113.7']);
    expect(sent).toHaveLength(0);
  });

  test('limits per device token', async () => {
    const perToken = limiter(false);
    const { sent, fetchImpl } = apnsStub(ok);
    const res = await push(fakeEnv(pem, { PER_TOKEN: perToken }), fetchImpl, cleartext);
    expect(res.status).toBe(429);
    expect(perToken.keys).toEqual([TOKEN]);
    expect(sent).toHaveLength(0);
  });

  test('rejects malformed and oversized bodies', async () => {
    const { fetchImpl } = apnsStub(ok);
    expect((await push(fakeEnv(pem), fetchImpl, '{')).status).toBe(400);
    expect((await push(fakeEnv(pem), fetchImpl, { token: TOKEN })).status).toBe(400);
    expect((await push(fakeEnv(pem), fetchImpl, 'x'.repeat(9 * 1024))).status).toBe(413);
  });

  test("maps APNs outcomes onto the relay's contract", async () => {
    const cases: [number, string, number, Record<string, unknown>][] = [
      [410, '{"reason":"Unregistered"}', 410, { error: 'unregistered' }],
      [429, '{"reason":"TooManyRequests"}', 503, { error: 'upstream_busy', reason: 'TooManyRequests' }],
      [400, '{"reason":"TopicDisallowed"}', 400, { error: 'rejected', reason: 'TopicDisallowed' }],
    ];
    for (const [apnsStatus, apnsBody, status, body] of cases) {
      const { fetchImpl } = apnsStub(() => new Response(apnsBody, { status: apnsStatus }));
      const res = await push(fakeEnv(pem), fetchImpl, cleartext);
      expect(res.status).toBe(status);
      expect((await res.json()) as unknown).toEqual(body);
    }
  });

  test('reports a transport failure as upstream_unavailable', async () => {
    const { fetchImpl } = apnsStub(() => {
      throw new Error('connection reset');
    });
    const res = await push(fakeEnv(pem), fetchImpl, cleartext);
    expect(res.status).toBe(502);
    expect((await res.json()) as unknown).toEqual({ error: 'upstream_unavailable' });
  });
});

describe('GET /health', () => {
  test('is healthy while the key signs', async () => {
    const res = await createApp().request('/health', {}, fakeEnv(pem));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true, signable: true });
  });

  test("fails when the key can't sign", async () => {
    const res = await createApp().request('/health', {}, fakeEnv('broken'));
    expect(res.status).toBe(503);
  });
});
