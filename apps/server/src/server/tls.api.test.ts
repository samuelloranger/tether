// End-to-end transport test: a real TLS listener, a real socket, and the
// pairing endpoints answering over it. This is the only place that proves the
// generated certificate is one Bun's TLS stack will actually serve — a unit test
// over DER bytes cannot tell you that.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:tls';
import { app } from './app';
import { setAuthHash } from './db';
import { resolveListenerPlan } from './tlsConfig';
import { publishTlsReport, resetTlsReport } from './tlsRuntime';
import { ensureTlsMaterial } from './tlsStore';

const root = mkdtempSync(path.join(tmpdir(), 'tether-tls-api-'));
const material = ensureTlsMaterial(path.join(root, 'tls'));
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

let httpsPort = 0;
let httpPort = 0;
let https: ReturnType<typeof Bun.serve>;
let http: ReturnType<typeof Bun.serve>;

// What a pinning client does: complete a handshake, then hash the certificate
// the server actually presented. This is the value /api/status must agree with.
function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(createHash('sha256').update(cert.raw).digest('hex'));
    });
    socket.on('error', reject);
  });
}

beforeAll(() => {
  https = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: material.certPem, key: material.keyPem },
    fetch: app.fetch,
  });
  http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
  httpsPort = Number(https.port);
  httpPort = Number(http.port);
  publishTlsReport({ ...resolveListenerPlan({}), httpPort, httpsPort }, material.fingerprintSha256);
});

afterAll(() => {
  resetTlsReport();
  https.stop(true);
  http.stop(true);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => setAuthHash(null));

describe('serving over TLS', () => {
  test('the generated certificate is one Bun will actually serve', async () => {
    const res = await fetch(`https://127.0.0.1:${httpsPort}/`, insecure);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'tether' });
  });

  test('a plaintext client on the http port keeps working unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'tether' });
  });

  test('the fingerprint on the wire is the certificate the connection presented', async () => {
    const res = await fetch(`https://127.0.0.1:${httpsPort}/api/status`, insecure);
    const body = (await res.json()) as {
      secure: boolean;
      tls: { enabled: boolean; fingerprint: string; port: number };
    };
    expect(body.secure).toBe(true);
    expect(body.tls.enabled).toBe(true);
    expect(body.tls.port).toBe(httpsPort);
    // The whole point of pinning: what /api/status claims must equal the
    // certificate actually terminating this connection.
    expect(body.tls.fingerprint).toBe(`sha256:${material.fingerprintSha256}`);
    expect(await peerFingerprint(httpsPort)).toBe(material.fingerprintSha256);
  });

  test('status over plaintext admits it is not secure, so a client refuses to pin', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
    const body = (await res.json()) as { secure: boolean; tls: { fingerprint: string } };
    expect(body.secure).toBe(false);
    // The fingerprint is still advertised — that is how a client discovers the
    // https port — but `secure: false` marks it as unverified discovery data.
    expect(body.tls.fingerprint).toBe(`sha256:${material.fingerprintSha256}`);
  });

  test('X-Forwarded-Proto cannot fake a secure connection', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/status`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(((await res.json()) as { secure: boolean }).secure).toBe(false);
  });

  test('status still reports needsSetup, so an old client is unaffected', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
    expect(((await res.json()) as { needsSetup: boolean }).needsSetup).toBe(true);
  });

  test('pairing over TLS returns the fingerprint to pin in the same round trip', async () => {
    const res = await fetch(`https://127.0.0.1:${httpsPort}/api/setup`, {
      ...insecure,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      secure: boolean;
      tls: { fingerprint: string };
    };
    expect(body.ok).toBe(true);
    expect(body.secure).toBe(true);
    expect(body.tls.fingerprint).toBe(`sha256:${material.fingerprintSha256}`);
    setAuthHash(null);
  });

  test('an authenticated WebSocket-less config read reports transport state', async () => {
    setAuthHash(await Bun.password.hash('pw', { algorithm: 'argon2id' }));
    const res = await fetch(`https://127.0.0.1:${httpsPort}/api/config`, {
      ...insecure,
      headers: { Authorization: 'Bearer pw' },
    });
    const body = (await res.json()) as { tls: { enabled: boolean; plaintext: boolean } };
    expect(body.tls.enabled).toBe(true);
    expect(body.tls.plaintext).toBe(true);
    setAuthHash(null);
  });
});
