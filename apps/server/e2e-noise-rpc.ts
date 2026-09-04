#!/usr/bin/env bun
/**
 * Live E2E for the Noise RPC tunnel: spins a temp server, pairs a device, then
 * over an IK-authenticated `/api/noise/rpc` channel issues `GET /api/sessions`
 * and checks the response comes back sealed (status 200, JSON array). Proves the
 * REST surface is reachable over Noise without a password.
 *
 * Self-contained — run from apps/server: `bun run e2e-noise-rpc.ts`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { derivePsk, genKeypair, pairInitiator, reconnectInitiator } from './src/server/noiseFfi';
import { decodeServerMessage, encodeMessage } from './src/server/noiseRpc';

const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const stateDir = mkdtempSync(path.join(tmpdir(), 'tether-rpc-e2e-'));
const tokenFile = path.join(stateDir, 'token');

const log = (...a: unknown[]) => console.log('[rpc-e2e]', ...a);
const die = (m: string): never => {
  console.error('[rpc-e2e] FAIL:', m);
  process.exit(1);
};

class WsClient {
  private queue: Uint8Array[] = [];
  private waiters: ((f: Uint8Array) => void)[] = [];
  private ws: WebSocket;
  ready: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
    });
    this.ws.onmessage = (ev) => {
      const b =
        ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new TextEncoder().encode(String(ev.data));
      const w = this.waiters.shift();
      if (w) w(b);
      else this.queue.push(b);
    };
  }
  send(f: Uint8Array) {
    this.ws.send(f);
  }
  recv(timeoutMs = 5000): Promise<Uint8Array> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws recv timeout')), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(t);
        res(f);
      });
    });
  }
  close() {
    this.ws.close();
  }
}

async function control(pathname: string, body?: unknown): Promise<Response> {
  const token = readFileSync(tokenFile, 'utf8').trim();
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tether-Present-Control': token },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  log('starting temp server, state=', stateDir);
  const server = Bun.spawn(['bun', 'run', 'src/server/main.ts', 'serve'], {
    env: {
      ...process.env,
      TETHER_PORT: String(PORT),
      TETHER_TLS: 'off',
      TETHER_DB_PATH: path.join(stateDir, 'tether.db'),
      TETHER_PRESENT_CONTROL_TOKEN_FILE: tokenFile,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/status`)).ok) break;
    } catch {}
    await Bun.sleep(200);
    if (i === 59) die('server never came up');
  }
  log('server up');

  const device = genKeypair();
  let serverPub: Uint8Array;

  try {
    // --- PAIR ---
    const open = await control('/control/pair/open');
    if (!open.ok) die(`pair/open ${open.status}`);
    const { code } = (await open.json()) as { code: string };
    const pairWs = new WsClient(`${WS}/api/noise/pair`);
    await pairWs.ready;
    const pi = pairInitiator(device.priv, derivePsk(code));
    pairWs.send(pi.writeMessage()); // -> e
    pi.readMessage(await pairWs.recv()); // <- e,ee,s,es
    pairWs.send(pi.writeMessage()); // -> s,se
    serverPub = pi.remoteStatic();
    pi.free();
    await Bun.sleep(300);
    const confirm = await control('/control/pair/confirm', { approve: true });
    if (!confirm.ok) die(`pair/confirm ${confirm.status}`);
    const reply = new TextDecoder().decode(await pairWs.recv());
    if (!reply.includes('true')) die(`pairing not ok: ${reply}`);
    pairWs.close();
    log('PAIRED ✓');

    // --- RPC: GET /api/sessions over the tunnel ---
    const rpcWs = new WsClient(`${WS}/api/noise/rpc`);
    await rpcWs.ready;
    const ri = reconnectInitiator(device.priv, serverPub);
    rpcWs.send(ri.writeMessage()); // -> e,es,s,ss
    ri.readMessage(await rpcWs.recv()); // <- e,ee,se
    ri.intoTransport();
    log('RPC CHANNEL AUTHORIZED ✓');

    const seal = (obj: unknown) => ri.seal(encodeMessage(obj as never));
    rpcWs.send(
      seal({ t: 'req', id: 1, method: 'GET', path: '/api/sessions', headers: {}, hasBody: false }),
    );
    rpcWs.send(seal({ t: 'req.end', id: 1 }));

    let status = 0;
    let bodyText = '';
    let done = false;
    const deadline = Date.now() + 8000;
    while (!done && Date.now() < deadline) {
      const wire = await rpcWs.recv(8000).catch(() => null);
      if (!wire) break;
      const msg = decodeServerMessage(ri.open(wire));
      if (msg.t === 'res' && msg.id === 1) status = msg.status;
      else if (msg.t === 'res.body' && msg.id === 1) bodyText += atob(msg.b64);
      else if (msg.t === 'res.end' && msg.id === 1) done = true;
      else if (msg.t === 'res.error' && msg.id === 1) die(`res.error: ${msg.message}`);
    }
    rpcWs.close();
    ri.free();

    if (status !== 200) die(`expected 200, got ${status}`);
    const parsed = JSON.parse(bodyText);
    if (!Array.isArray(parsed)) die(`expected a JSON array body, got: ${bodyText.slice(0, 120)}`);
    log(`GET /api/sessions over Noise → ${status}, ${parsed.length} session(s) ✓`);
    log('\n=== RPC E2E PASSED: pair → rpc channel → GET /api/sessions, all Noise-sealed ===');
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
