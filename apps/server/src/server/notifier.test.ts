import { expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from './config';
import { buildNotification, send } from './notifier';

const cfg = {
  ...DEFAULT_CONFIG,
  notify: { ...DEFAULT_CONFIG.notify, enabled: true, topic: 'tether-test' },
  identity: { ...DEFAULT_CONFIG.identity, name: 'Mac mini' },
};

test('buildNotification maps waiting to an ntfy payload and deep link', () => {
  expect(
    buildNotification({ type: 'waiting' }, { sessionId: 'abc', sessionTitle: 'shell' }, cfg),
  ).toEqual({
    topic: 'tether-test',
    title: 'Mac mini · shell',
    message: 'Waiting for input',
    tags: ['waiting'],
    priority: 4,
    click: 'tether://session/abc?host=Mac%20mini',
  });
});

test('disabled triggers suppress notifications and send swallows failures', async () => {
  expect(
    buildNotification(
      { type: 'exit' },
      { sessionId: 'abc', sessionTitle: 'shell' },
      { ...cfg, triggers: { ...cfg.triggers, exit: false } },
    ),
  ).toBeNull();
  const payload = buildNotification(
    { type: 'exit' },
    { sessionId: 'abc', sessionTitle: 'shell' },
    cfg,
  )!;
  await expect(
    send(payload, cfg, async () => {
      throw new Error('offline');
    }),
  ).resolves.toBeUndefined();
});

test('retries delivery once after a one-second delay and still lets send swallow failures', async () => {
  const attempts: number[] = [];
  await send(
    { topic: 'tether-test', title: 'Test', message: 'Test', tags: [], click: 'tether://' },
    cfg,
    async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw new Error('offline');
      return new Response(null, { status: 503 });
    },
  );

  expect(attempts).toHaveLength(2);
  expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(900);
});

test('disables automatic redirects during notification delivery', async () => {
  const requests: Array<RequestInit | undefined> = [];
  await send(
    { topic: 'tether-test', title: 'Test', message: 'Test', tags: [], click: 'tether://' },
    cfg,
    async (_url, init) => {
      requests.push(init);
      return new Response(null, { status: 200 });
    },
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]?.redirect).toBe('error');
});
