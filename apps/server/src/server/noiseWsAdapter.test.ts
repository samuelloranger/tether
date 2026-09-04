import { describe, expect, test } from 'bun:test';
import { toFrameBytes, WsFrameIO } from './noiseWsAdapter';

function fakeWs(): { send: (data: Uint8Array) => void; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return { send: (data) => void sent.push(data), sent };
}

describe('WsFrameIO', () => {
  test('push then recv returns frames in order', async () => {
    const io = new WsFrameIO(fakeWs());
    io.push(Uint8Array.of(1));
    io.push(Uint8Array.of(2));
    expect(await io.recv()).toEqual(Uint8Array.of(1));
    expect(await io.recv()).toEqual(Uint8Array.of(2));
  });

  test('recv awaits a later push', async () => {
    const io = new WsFrameIO(fakeWs());
    const pending = io.recv();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    io.push(Uint8Array.of(42));
    expect(await pending).toEqual(Uint8Array.of(42));
  });

  test('send writes raw bytes out the injected ws', () => {
    const ws = fakeWs();
    const io = new WsFrameIO(ws);
    const frame = Uint8Array.of(9, 8, 7);
    io.send(frame);
    expect(ws.sent).toEqual([frame]);
  });

  test('close rejects a pending recv', async () => {
    const io = new WsFrameIO(fakeWs());
    const pending = io.recv();
    io.close();
    expect(io.closed).toBe(true);
    await expect(pending).rejects.toThrow('WsFrameIO closed');
  });

  test('recv after close rejects; queued frames still drain first', async () => {
    const io = new WsFrameIO(fakeWs());
    io.push(Uint8Array.of(5));
    io.close();
    expect(await io.recv()).toEqual(Uint8Array.of(5)); // queued frame drains
    await expect(io.recv()).rejects.toThrow('WsFrameIO closed');
  });

  test('push after close is dropped', async () => {
    const io = new WsFrameIO(fakeWs());
    io.close();
    io.push(Uint8Array.of(1));
    await expect(io.recv()).rejects.toThrow('WsFrameIO closed');
  });

  test('overflow past maxQueue closes the adapter fatally', async () => {
    const io = new WsFrameIO(fakeWs(), 2);
    io.push(Uint8Array.of(1));
    io.push(Uint8Array.of(2));
    io.push(Uint8Array.of(3)); // exceeds bound -> fatal close
    expect(io.closed).toBe(true);
    // Drains the two frames it accepted, then rejects.
    expect(await io.recv()).toEqual(Uint8Array.of(1));
    expect(await io.recv()).toEqual(Uint8Array.of(2));
    await expect(io.recv()).rejects.toThrow('overflow');
  });
});

describe('toFrameBytes', () => {
  test('passes through an ArrayBuffer as owned bytes', () => {
    const src = Uint8Array.of(1, 2, 3);
    const out = toFrameBytes(src.buffer);
    expect(out).toEqual(src);
  });

  test('copies a typed-array view to its own bytes', () => {
    const backing = Uint8Array.of(0, 1, 2, 3, 4);
    const view = backing.subarray(1, 4); // offset view over shared buffer
    const out = toFrameBytes(view);
    expect(out).toEqual(Uint8Array.of(1, 2, 3));
    backing[1] = 99; // mutating the source must not affect the copy
    expect(out).toEqual(Uint8Array.of(1, 2, 3));
  });

  test('returns null for a text (string) frame', () => {
    expect(toFrameBytes('hello')).toBeNull();
  });
});
