import { describe, expect, test } from 'bun:test';
import { concatFrames, encodeFrame, FRAME_HEADER_BYTES, FrameDecoder } from './frame';

const bytes = (...v: number[]) => new Uint8Array(v);

describe('encodeFrame', () => {
  test('writes kind, big-endian length, then payload', () => {
    const frame = encodeFrame(7, bytes(0xaa, 0xbb, 0xcc));
    expect([...frame]).toEqual([7, 0, 0, 0, 3, 0xaa, 0xbb, 0xcc]);
  });

  test('an empty payload is a bare 5-byte header', () => {
    const frame = encodeFrame(6);
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES);
    expect([...frame]).toEqual([6, 0, 0, 0, 0]);
  });

  test('lengths above 64KB stay exact (no u16 truncation)', () => {
    const payload = new Uint8Array(70_000).fill(1);
    const frame = encodeFrame(1, payload);
    expect([...frame.subarray(0, 5)]).toEqual([1, 0, 1, 0x11, 0x70]);
    expect(new FrameDecoder().push(frame)[0].payload.byteLength).toBe(70_000);
  });

  test('rejects a kind that does not fit in a byte', () => {
    expect(() => encodeFrame(256)).toThrow(RangeError);
    expect(() => encodeFrame(-1)).toThrow(RangeError);
  });
});

describe('FrameDecoder', () => {
  test('round-trips a frame', () => {
    const frames = new FrameDecoder().push(encodeFrame(3, bytes(1, 2, 3)));
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe(3);
    expect([...frames[0].payload]).toEqual([1, 2, 3]);
  });

  test('decodes several frames from one chunk', () => {
    const chunk = concatFrames([
      encodeFrame(1, bytes(9)),
      encodeFrame(2),
      encodeFrame(3, bytes(8)),
    ]);
    const frames = new FrameDecoder().push(chunk);
    expect(frames.map((f) => f.kind)).toEqual([1, 2, 3]);
    expect([...frames[0].payload]).toEqual([9]);
    expect(frames[1].payload.byteLength).toBe(0);
  });

  test('reassembles a frame split byte by byte', () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame(4, bytes(1, 2, 3, 4, 5));
    const out: number[][] = [];
    for (const b of frame) {
      for (const f of dec.push(bytes(b))) out.push([...f.payload]);
    }
    expect(out).toEqual([[1, 2, 3, 4, 5]]);
    expect(dec.pending).toBe(0);
  });

  test('holds a partial header until the rest arrives', () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame(5, bytes(7, 7));
    expect(dec.push(frame.subarray(0, 3))).toEqual([]);
    expect(dec.pending).toBe(3);
    const frames = dec.push(frame.subarray(3));
    expect(frames).toHaveLength(1);
    expect([...frames[0].payload]).toEqual([7, 7]);
  });

  test('payload bytes that look like a header do not resync the stream', () => {
    // A raw PTY payload can contain anything, newlines included — which is the
    // whole reason the old newline-delimited holder protocol needed base64.
    const payload = bytes(1, 0, 0, 0, 99, 0x0a, 0x7b, 0x0a);
    const frames = new FrameDecoder().push(encodeFrame(1, payload));
    expect(frames).toHaveLength(1);
    expect([...frames[0].payload]).toEqual([...payload]);
  });

  test('throws on an absurd length prefix instead of allocating', () => {
    const dec = new FrameDecoder(1024);
    expect(() => dec.push(bytes(1, 0xff, 0xff, 0xff, 0xff))).toThrow(RangeError);
  });

  test('a decoded payload does not alias the read buffer', () => {
    const dec = new FrameDecoder();
    const chunk = concatFrames([encodeFrame(1, bytes(1, 1)), encodeFrame(1, bytes(2, 2))]);
    const [first, second] = dec.push(chunk);
    expect([...first.payload]).toEqual([1, 1]);
    expect([...second.payload]).toEqual([2, 2]);
    expect(first.payload.buffer).not.toBe(second.payload.buffer);
  });
});
