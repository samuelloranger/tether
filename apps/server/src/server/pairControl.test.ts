import { describe, expect, test } from 'bun:test';
import { PairingError } from './enrollment';
import type { FrameIO } from './noiseChannel';
import { derivePsk, genKeypair, pairInitiator } from './noiseFfi';
import { serverFingerprint } from './noiseIdentity';
import { createPairControl, pairControlRoutes } from './pairControl';
import { presentationControlToken } from './routes/presentations';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Two linked FrameIOs: each side's send lands in the other's recv queue.
function pipe(): [FrameIO, FrameIO] {
  const toServer: Uint8Array[] = [];
  const toClient: Uint8Array[] = [];
  const wait = async (q: Uint8Array[]): Promise<Uint8Array> => {
    while (q.length === 0) await new Promise((r) => setTimeout(r, 0));
    return q.shift() as Uint8Array;
  };
  const serverIo: FrameIO = { send: (f) => void toClient.push(f), recv: () => wait(toServer) };
  const clientIo: FrameIO = { send: (f) => void toServer.push(f), recv: () => wait(toClient) };
  return [serverIo, clientIo];
}

async function driveDevice(io: FrameIO, devicePriv: Uint8Array, code: string): Promise<void> {
  const i = pairInitiator(devicePriv, derivePsk(code));
  await io.send(i.writeMessage()); // -> e
  i.readMessage(await io.recv()); // <- e, ee, s, es
  await io.send(i.writeMessage()); // -> s, se
  i.intoTransport();
  i.free();
}

async function untilPending(
  control: ReturnType<typeof createPairControl>,
  timeoutMs = 2000,
): Promise<NonNullable<ReturnType<typeof control.getPending>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = control.getPending();
    if (pending) return pending;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for a pending pairing proposal');
}

describe('pairControl open', () => {
  test('open returns a code and the server fingerprint', () => {
    const server = genKeypair();
    const control = createPairControl({ loadKeypair: () => server });
    const opened = control.open();
    expect(opened.code).toHaveLength(12);
    expect([...opened.code].every((ch) => ALPHABET.includes(ch))).toBe(true);
    expect(opened.expiresAt).toBeGreaterThan(Date.now());
    expect(opened.fingerprint).toBe(serverFingerprint(server.pub));
  });

  test('POST /control/pair/open is gated by the present control token', async () => {
    const rejected = await pairControlRoutes.request('/control/pair/open', { method: 'POST' });
    expect(rejected.status).toBe(401);

    const opened = await pairControlRoutes.request('/control/pair/open', {
      method: 'POST',
      headers: { 'X-Tether-Present-Control': presentationControlToken },
    });
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as { code: string; expiresAt: number; fingerprint: string };
    expect(body.code).toHaveLength(12);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.expiresAt).toBe('number');
  });
});

describe('pairControl handlePairingConnection', () => {
  test('parks a pending proposal and enrolls on confirm(true)', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const added: { label: string; pubkey: string; address?: string }[] = [];
    const control = createPairControl({
      loadKeypair: () => server,
      addDevice: (input) => {
        added.push(input);
        return { pubkey: input.pubkey };
      },
    });
    const { code } = control.open();
    const [serverIo, clientIo] = pipe();

    const pairing = control.handlePairingConnection(serverIo);
    const driven = driveDevice(clientIo, device.priv, code);
    const pending = await untilPending(control);
    expect(pending.label).toBe('device');
    expect(pending.pubkeyBase64).toBe(devPubB64);
    expect(pending.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(control.confirm(true)).toBe(true);
    const result = await pairing;
    await driven;

    expect(result.pubkey).toBe(devPubB64);
    expect(added).toEqual([{ label: 'device', pubkey: devPubB64, address: undefined }]);
    expect(control.getPending()).toBeNull();
  });

  test('confirm(false) rejects and does not enroll', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const added: { label: string; pubkey: string; address?: string }[] = [];
    const control = createPairControl({
      loadKeypair: () => server,
      addDevice: (input) => {
        added.push(input);
        return { pubkey: input.pubkey };
      },
    });
    const { code } = control.open();
    const [serverIo, clientIo] = pipe();

    const pairing = control.handlePairingConnection(serverIo);
    const driven = driveDevice(clientIo, device.priv, code);
    await untilPending(control);

    expect(control.confirm(false)).toBe(true);
    await expect(pairing).rejects.toBeInstanceOf(PairingError);
    await expect(pairing).rejects.toMatchObject({ code: 'rejected' });
    await driven;
    expect(added).toHaveLength(0);
  });
});
