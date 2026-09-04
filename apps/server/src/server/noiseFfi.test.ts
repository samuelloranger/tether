import { describe, expect, test } from 'bun:test';
import { derivePsk, genKeypair, pairInitiator, pairResponder } from './noiseFfi';

describe('noise ffi', () => {
  test('pair through ffi then exchange an encrypted frame', () => {
    const device = genKeypair();
    const server = genKeypair();
    const psk = derivePsk('011B-2345-6789');

    const i = pairInitiator(device.priv, psk);
    const r = pairResponder(server.priv, psk);

    // XX: -> e ; <- e,ee,s,es ; -> s,se
    r.readMessage(i.writeMessage());
    i.readMessage(r.writeMessage());
    r.readMessage(i.writeMessage());

    expect(i.isFinished()).toBe(true);
    expect(r.isFinished()).toBe(true);
    expect([...r.remoteStatic()]).toEqual([...device.pub]);

    i.intoTransport();
    r.intoTransport();

    const msg = new TextEncoder().encode('hello over the ffi wire');
    const plain = r.open(i.seal(msg));
    expect(new TextDecoder().decode(plain)).toBe('hello over the ffi wire');

    i.free();
    r.free();
  });
});
