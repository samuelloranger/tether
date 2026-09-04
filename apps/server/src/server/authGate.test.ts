import { describe, expect, test } from 'bun:test';
import { runReconnect } from './authGate';
import type { FrameIO } from './noiseChannel';
import { genKeypair, reconnectInitiator } from './noiseFfi';

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

describe('runReconnect', () => {
  test('authorized device: returns device, frame round-trips, touch called', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const [serverIo, clientIo] = pipe();

    const touched: string[] = [];
    const serverPromise = runReconnect(serverIo, server.priv, {
      getDeviceByPubkey: (pk) => (pk === devPubB64 ? { id: 'dev-1', pubkey: pk } : null),
      touchDevice: (pk) => void touched.push(pk),
    });

    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage());
    i.readMessage(await clientIo.recv());
    i.intoTransport();

    const { channel, device: dev } = await serverPromise;
    expect(dev.id).toBe('dev-1');
    expect(touched).toEqual([devPubB64]);

    await clientIo.send(i.seal(new TextEncoder().encode('hi')));
    expect(new TextDecoder().decode(channel.open(await serverIo.recv()))).toBe('hi');

    i.free();
    channel.free();
  });

  test('unauthorized device: rejects, touch NOT called', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const [serverIo, clientIo] = pipe();

    let touchCount = 0;
    const serverPromise = runReconnect(serverIo, server.priv, {
      getDeviceByPubkey: () => null,
      touchDevice: () => {
        touchCount += 1;
      },
    });

    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage());

    await expect(serverPromise).rejects.toMatchObject({ code: 'unauthorized' });
    expect(touchCount).toBe(0);
    i.free();
  });
});
