import { describe, expect, test } from 'bun:test';
import { acceptPairing, acceptReconnect, type FrameIO } from './noiseChannel';
import { derivePsk, genKeypair, pairInitiator, reconnectInitiator } from './noiseFfi';

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

describe('noise channel — reconnect', () => {
  test('authorized device reconnects and exchanges a frame both ways', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptReconnect(serverIo, server.priv, (pk) =>
      pk === devPubB64 ? { pk } : null,
    );

    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage()); // -> e, es, s, ss
    i.readMessage(await clientIo.recv()); // <- e, ee, se
    i.intoTransport();

    const channel = await serverPromise;
    expect(channel.device).toEqual({ pk: devPubB64 });

    // device -> server
    await clientIo.send(i.seal(new TextEncoder().encode('up')));
    expect(new TextDecoder().decode(channel.open(await serverIo.recv()))).toBe('up');
    // server -> device
    await serverIo.send(channel.seal(new TextEncoder().encode('down')));
    expect(new TextDecoder().decode(i.open(await clientIo.recv()))).toBe('down');

    i.free();
    channel.free();
  });

  test('unknown device is refused before any app data', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const [serverIo, clientIo] = pipe();
    const serverPromise = acceptReconnect(serverIo, server.priv, () => null); // deny all

    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage());

    await expect(serverPromise).rejects.toMatchObject({ code: 'handshake' });
    i.free();
  });

  test('unknown device and a garbage handshake reject with the same ChannelError code', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const [ioA, clientA] = pipe();
    const unknown = acceptReconnect(ioA, server.priv, () => null);
    const i = reconnectInitiator(device.priv, server.pub);
    await clientA.send(i.writeMessage());
    const [ioB, clientB] = pipe();
    const garbage = acceptReconnect(ioB, server.priv, () => ({ ok: true }));
    await clientB.send(new Uint8Array([1, 2, 3, 4])); // truncated/garbage
    const [errUnknown, errGarbage] = await Promise.allSettled([unknown, garbage]);
    expect(errUnknown).toMatchObject({ status: 'rejected', reason: { code: 'handshake' } });
    expect(errGarbage).toMatchObject({ status: 'rejected', reason: { code: 'handshake' } });
    i.free();
  });
});

describe('noise channel — pairing', () => {
  test('pairing with host-confirm=true yields the device pubkey + a working channel', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const psk = derivePsk('011B-2345-6789');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptPairing(serverIo, server.priv, {
      psk,
      confirm: () => true,
    });

    const i = pairInitiator(device.priv, psk);
    await clientIo.send(i.writeMessage()); // -> e
    i.readMessage(await clientIo.recv()); // <- e, ee, s, es
    await clientIo.send(i.writeMessage()); // -> s, se
    i.intoTransport();

    const { channel, devicePubkey } = await serverPromise;
    expect(devicePubkey).toBe(devPubB64);

    await clientIo.send(i.seal(new TextEncoder().encode('enrolled')));
    expect(new TextDecoder().decode(channel.open(await serverIo.recv()))).toBe('enrolled');

    i.free();
    channel.free();
  });

  test('host-confirm=false rejects the pairing', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const psk = derivePsk('011B-2345-6789');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptPairing(serverIo, server.priv, { psk, confirm: () => false });

    const i = pairInitiator(device.priv, psk);
    await clientIo.send(i.writeMessage());
    i.readMessage(await clientIo.recv());
    await clientIo.send(i.writeMessage());

    await expect(serverPromise).rejects.toMatchObject({ code: 'rejected' });
    i.free();
  });
});

describe('noise channel — pairing timeouts', () => {
  // A crypto handshake that stalls (device never sends its final message) must
  // fail fast, bounded by handshakeTimeoutMs — not hang holding the socket.
  test('a stalled crypto handshake fails within handshakeTimeoutMs', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const psk = derivePsk('011B-2345-6789');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptPairing(serverIo, server.priv, {
      psk,
      confirm: () => true,
      handshakeTimeoutMs: 50,
      confirmTimeoutMs: 5_000,
    });

    const i = pairInitiator(device.priv, psk);
    await clientIo.send(i.writeMessage()); // -> e
    i.readMessage(await clientIo.recv()); // <- e, ee, s, es
    // Never send the third message — the crypto handshake stalls here.

    await expect(serverPromise).rejects.toMatchObject({ code: 'handshake' });
    i.free();
  });

  // The user-facing bug: a host-confirm that takes LONGER than the crypto
  // handshake timeout (a human reading a code and typing 'y') must still pair.
  // The handshake timeout bounds only the crypto exchange, never the confirm.
  test('a host-confirm slower than handshakeTimeoutMs still pairs', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const psk = derivePsk('011B-2345-6789');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptPairing(serverIo, server.priv, {
      psk,
      // Resolves well after the 60ms handshake window, within the confirm window.
      confirm: () => new Promise((r) => setTimeout(() => r(true), 150)),
      handshakeTimeoutMs: 60,
      confirmTimeoutMs: 2_000,
    });

    const i = pairInitiator(device.priv, psk);
    await clientIo.send(i.writeMessage()); // -> e
    i.readMessage(await clientIo.recv()); // <- e, ee, s, es
    await clientIo.send(i.writeMessage()); // -> s, se
    i.intoTransport();

    const { devicePubkey } = await serverPromise;
    expect(devicePubkey).toBe(devPubB64);
    i.free();
  });

  // A confirm that never arrives (operator walked away) must not pin the socket
  // forever — it fails, bounded by confirmTimeoutMs.
  test('a host-confirm that never answers fails within confirmTimeoutMs', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const psk = derivePsk('011B-2345-6789');
    const [serverIo, clientIo] = pipe();

    const serverPromise = acceptPairing(serverIo, server.priv, {
      psk,
      confirm: () => new Promise<boolean>(() => {}), // never resolves
      handshakeTimeoutMs: 5_000,
      confirmTimeoutMs: 50,
    });

    const i = pairInitiator(device.priv, psk);
    await clientIo.send(i.writeMessage()); // -> e
    i.readMessage(await clientIo.recv()); // <- e, ee, s, es
    await clientIo.send(i.writeMessage()); // -> s, se
    i.intoTransport();

    await expect(serverPromise).rejects.toMatchObject({ code: 'handshake' });
    i.free();
  });
});
