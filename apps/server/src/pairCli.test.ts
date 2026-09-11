import { expect, test } from 'bun:test';
import { groupPairCode, runPair } from './pairCli';

const SOCK = '/tmp/tether-control.sock';

test('groups a 12-char code as XXXX-XXXX-XXXX', () => {
  expect(groupPairCode('0123456789AB')).toBe('0123-4567-89AB');
});

test('opens a window over the socket, prints the grouped code, and posts the TTY decision', async () => {
  const requests: Request[] = [];
  const inits: RequestInit[] = [];
  const logs: string[] = [];
  let pendingHits = 0;

  await runPair({
    sock: SOCK,
    log: (msg) => logs.push(msg),
    readLine: async () => 'y',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      inits.push(init ?? {});
      const url = new URL(String(input));
      if (url.pathname === '/control/pair/open') {
        return Response.json({
          code: '0123456789AB',
          expiresAt: Date.now() + 60_000,
          fingerprint: 'aa'.repeat(32),
        });
      }
      if (url.pathname === '/control/pair/pending') {
        pendingHits += 1;
        if (pendingHits === 1) return Response.json({ pending: null });
        return Response.json({
          pending: { label: 'sam-iphone', pubkeyBase64: 'devkey', fingerprint: 'bb'.repeat(32) },
        });
      }
      if (url.pathname === '/control/pair/confirm') return Response.json({ approved: true });
      if (url.pathname === '/control/pair/close') return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    },
  });

  expect(requests[0]?.url).toBe('http://localhost/control/pair/open');
  expect((inits[0] as { unix?: string }).unix).toBe(SOCK);
  expect(requests[0]?.headers.get('X-Tether-Present-Control')).toBeNull();
  expect(logs).toContain('Pairing code: 0123-4567-89AB');
  expect(logs.some((line) => line.includes('Enter this code on the device'))).toBe(true);
  expect(logs.some((line) => line.includes("Device 'sam-iphone'"))).toBe(true);
  expect(logs).toContain('Device approved.');

  const confirm = requests.find((r) => new URL(r.url).pathname === '/control/pair/confirm');
  expect(await confirm?.json()).toEqual({ approve: true });

  const close = requests.find((r) => new URL(r.url).pathname === '/control/pair/close');
  expect(close?.method).toBe('POST');
});

test('prints advertise URL and QR when advertiseUrl is set', async () => {
  const logs: string[] = [];

  await runPair({
    sock: SOCK,
    advertiseUrl: 'http://10.0.0.5:8085',
    qr: async (p) => `QR:${p}`,
    log: (msg) => logs.push(msg),
    readLine: async () => 'y',
    fetch: async (input) => {
      const pathName = new URL(String(input)).pathname;
      if (pathName === '/control/pair/open') {
        return Response.json({
          code: '7QF4KM9PX3TV',
          expiresAt: Date.now() + 60_000,
          fingerprint: 'aa'.repeat(32),
        });
      }
      if (pathName === '/control/pair/pending') {
        return Response.json({
          pending: { label: 'device', pubkeyBase64: 'k', fingerprint: 'bb'.repeat(32) },
        });
      }
      if (pathName === '/control/pair/confirm') return Response.json({ approved: true });
      return Response.json({ ok: true });
    },
  });

  expect(logs).toContain('Pairing code: 7QF4-KM9P-X3TV');
  expect(logs).toContain('http://10.0.0.5:8085');
  expect(logs.some((line) => line.startsWith('QR:tether://pair?'))).toBe(true);
  expect(
    logs.some((line) => line.includes('code=7QF4-KM9P-X3TV&host=http%3A%2F%2F10.0.0.5%3A8085')),
  ).toBe(true);
});

test('skips QR when advertiseUrl is null but still prints the code', async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: string) => errors.push(msg);

  try {
    await runPair({
      sock: SOCK,
      advertiseUrl: null,
      log: (msg) => logs.push(msg),
      readLine: async () => 'y',
      fetch: async (input) => {
        const pathName = new URL(String(input)).pathname;
        if (pathName === '/control/pair/open') {
          return Response.json({
            code: '0123456789AB',
            expiresAt: Date.now() + 60_000,
            fingerprint: 'aa'.repeat(32),
          });
        }
        if (pathName === '/control/pair/pending') {
          return Response.json({
            pending: { label: 'device', pubkeyBase64: 'k', fingerprint: 'bb'.repeat(32) },
          });
        }
        if (pathName === '/control/pair/confirm') return Response.json({ approved: true });
        return Response.json({ ok: true });
      },
    });
  } finally {
    console.error = origError;
  }

  expect(logs).toContain('Pairing code: 0123-4567-89AB');
  expect(errors.some((line) => line.includes('scan skipped'))).toBe(true);
  expect(logs.some((line) => line.startsWith('QR:'))).toBe(false);
});

test('posts approve:false when the TTY answers n', async () => {
  let confirmBody: unknown;
  const logs: string[] = [];

  await runPair({
    sock: SOCK,
    log: (msg) => logs.push(msg),
    readLine: async () => 'n',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const pathName = new URL(request.url).pathname;
      if (pathName === '/control/pair/open') {
        return Response.json({
          code: '0123456789AB',
          expiresAt: Date.now() + 60_000,
          fingerprint: 'aa'.repeat(32),
        });
      }
      if (pathName === '/control/pair/pending') {
        return Response.json({
          pending: { label: 'device', pubkeyBase64: 'k', fingerprint: 'cc'.repeat(32) },
        });
      }
      if (pathName === '/control/pair/confirm') {
        confirmBody = await request.json();
        return Response.json({ approved: false });
      }
      return Response.json({ ok: true });
    },
  });

  expect(confirmBody).toEqual({ approve: false });
  expect(logs).toContain('Device rejected.');
});
