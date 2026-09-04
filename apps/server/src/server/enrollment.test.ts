import { describe, expect, test } from 'bun:test';
import { EnrollmentWindow, generateCode, PairingError, runPairing } from './enrollment';
import type { FrameIO } from './noiseChannel';
import { derivePsk, genKeypair, pairInitiator } from './noiseFfi';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function pipe(): [FrameIO, FrameIO] {
  const toServer: Uint8Array[] = [];
  const toClient: Uint8Array[] = [];
  const wait = async (q: Uint8Array[]): Promise<Uint8Array> => {
    while (q.length === 0) await new Promise((r) => setTimeout(r, 0));
    return q.shift() as Uint8Array;
  };
  return [
    { send: (f) => void toClient.push(f), recv: () => wait(toServer) },
    { send: (f) => void toServer.push(f), recv: () => wait(toClient) },
  ];
}

describe('enrollment code', () => {
  test('generateCode is 12 alphabet chars and varies', () => {
    const c = generateCode();
    expect(c.length).toBe(12);
    expect([...c].every((ch) => ALPHABET.includes(ch))).toBe(true);
    expect(generateCode()).not.toBe(c);
  });
});

describe('enrollment window', () => {
  test('open makes it usable; psk is 32 bytes', () => {
    const w = new EnrollmentWindow();
    expect(w.isOpen()).toBe(false);
    w.open();
    expect(w.isOpen()).toBe(true);
    expect(w.psk().length).toBe(32);
  });

  test('expires after ttl', () => {
    let t = 1000;
    const w = new EnrollmentWindow({ ttlMs: 500, now: () => t });
    w.open();
    expect(w.isOpen()).toBe(true);
    t += 600;
    expect(w.isOpen()).toBe(false);
    expect(() => w.psk()).toThrow();
  });

  test('closes after maxAttempts', () => {
    const w = new EnrollmentWindow({ maxAttempts: 2 });
    w.open();
    w.recordAttempt();
    expect(w.isOpen()).toBe(true);
    w.recordAttempt();
    expect(w.isOpen()).toBe(false);
  });

  test('consume closes it', () => {
    const w = new EnrollmentWindow();
    w.open();
    w.consume();
    expect(w.isOpen()).toBe(false);
  });
});

describe('runPairing', () => {
  async function driveDevice(io: FrameIO, devicePriv: Uint8Array, code: string): Promise<void> {
    const i = pairInitiator(devicePriv, derivePsk(code));
    await io.send(i.writeMessage()); // -> e
    i.readMessage(await io.recv()); // <- e, ee, s, es
    await io.send(i.writeMessage()); // -> s, se
    i.intoTransport();
    i.free();
  }

  test('happy path enrolls the device and consumes the window', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const w = new EnrollmentWindow();
    const { code } = w.open();
    const [serverIo, clientIo] = pipe();

    const added: { label: string; pubkey: string; address?: string }[] = [];
    const serverPromise = runPairing(serverIo, server.priv, w, {
      label: 'sam-iphone',
      addDevice: (input) => {
        added.push(input);
        return { pubkey: input.pubkey };
      },
      confirm: () => true,
    });

    await driveDevice(clientIo, device.priv, code);
    const result = await serverPromise;

    expect(result.pubkey).toBe(devPubB64);
    expect(added).toEqual([{ label: 'sam-iphone', pubkey: devPubB64, address: undefined }]);
    expect(w.isOpen()).toBe(false); // consumed
  });

  test('closed window rejects before any handshake', async () => {
    const server = genKeypair();
    const w = new EnrollmentWindow(); // never opened
    const [serverIo] = pipe();
    await expect(
      runPairing(serverIo, server.priv, w, {
        label: 'x',
        addDevice: (i) => ({ pubkey: i.pubkey }),
        confirm: () => true,
      }),
    ).rejects.toBeInstanceOf(PairingError);
  });

  test('host rejection records an attempt and does not enroll', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const w = new EnrollmentWindow({ maxAttempts: 5 });
    const { code } = w.open();
    const [serverIo, clientIo] = pipe();

    let added = 0;
    const serverPromise = runPairing(serverIo, server.priv, w, {
      label: 'x',
      addDevice: () => {
        added += 1;
        return { pubkey: '' };
      },
      confirm: () => false,
    });

    await driveDevice(clientIo, device.priv, code);
    await expect(serverPromise).rejects.toMatchObject({ code: 'rejected' });
    expect(added).toBe(0);
  });
});
