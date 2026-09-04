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

    await expect(serverPromise).rejects.toMatchObject({ code: 'unauthorized' });
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
