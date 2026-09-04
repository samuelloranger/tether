import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { groupPairCode, runPair } from './pairCli';

test('groups a 12-char code as XXXX-XXXX-XXXX', () => {
  expect(groupPairCode('0123456789AB')).toBe('0123-4567-89AB');
});

test('opens a window, prints the grouped code, and posts the TTY decision', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-pair-'));
  try {
    const tokenFile = path.join(root, 'token');
    await Bun.write(tokenFile, 'local-token');
    const requests: Request[] = [];
    const logs: string[] = [];
    let pendingHits = 0;

    await runPair({
      port: '8085',
      tokenFile,
      log: (msg) => logs.push(msg),
      readLine: async () => 'y',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
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
            pending: {
              label: 'sam-iphone',
              pubkeyBase64: 'devkey',
              fingerprint: 'bb'.repeat(32),
            },
          });
        }
        if (url.pathname === '/control/pair/confirm') {
          return Response.json({ approved: true });
        }
        if (url.pathname === '/control/pair/close') {
          return Response.json({ ok: true });
        }
        return new Response('not found', { status: 404 });
      },
    });

    expect(requests[0]?.url).toBe('http://127.0.0.1:8085/control/pair/open');
    expect(requests[0]?.headers.get('X-Tether-Present-Control')).toBe('local-token');
    expect(logs).toContain('Pairing code: 0123-4567-89AB');
    expect(logs.some((line) => line.includes('Enter this code on the device'))).toBe(true);
    expect(logs.some((line) => line.includes("Device 'sam-iphone'"))).toBe(true);
    expect(logs).toContain('Device approved.');

    const confirm = requests.find((r) => new URL(r.url).pathname === '/control/pair/confirm');
    expect(confirm?.headers.get('X-Tether-Present-Control')).toBe('local-token');
    expect(await confirm?.json()).toEqual({ approve: true });

    const close = requests.find((r) => new URL(r.url).pathname === '/control/pair/close');
    expect(close?.method).toBe('POST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('posts approve:false when the TTY answers n', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-pair-n-'));
  try {
    const tokenFile = path.join(root, 'token');
    await Bun.write(tokenFile, 'local-token');
    let confirmBody: unknown;
    const logs: string[] = [];

    await runPair({
      port: '8085',
      tokenFile,
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
