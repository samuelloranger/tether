import { describe, expect, test } from 'bun:test';
import { FrameDecoder } from './frame';
import {
  decodeActivityFrame,
  decodeClientFrame,
  decodeCursorFrame,
  decodeDiffFrame,
  decodeExitFrame,
  decodeTitleFrame,
  encodeActivityFrame,
  encodeClientMessage,
  encodeCursorFrame,
  encodeDiffFrame,
  encodeExitFrame,
  encodeOutputFrame,
  encodePingFrame,
  encodeResetFrame,
  encodeTitleFrame,
  FrameKind,
} from './wireCodec';

const one = (bytes: Uint8Array) => {
  const frames = new FrameDecoder().push(bytes);
  expect(frames).toHaveLength(1);
  return frames[0];
};

describe('protocol v2 server -> client frames', () => {
  test('output carries raw bytes with no wrapper and no base64', () => {
    const frame = one(encodeOutputFrame('\x1b[31mred\x1b[0m'));
    expect(frame.kind).toBe(FrameKind.OUTPUT);
    expect(new TextDecoder().decode(frame.payload)).toBe('\x1b[31mred\x1b[0m');
    // 12 UTF-8 bytes, unescaped — JSON would spend 6 bytes per ESC alone.
    expect(frame.payload.byteLength).toBe(12);
  });

  test('output accepts bytes directly', () => {
    const frame = one(encodeOutputFrame(new Uint8Array([0x00, 0xff, 0x0a])));
    expect([...frame.payload]).toEqual([0x00, 0xff, 0x0a]);
  });

  test('cursor round-trips', () => {
    const frame = one(encodeCursorFrame('abc123'));
    expect(frame.kind).toBe(FrameKind.CURSOR);
    expect(decodeCursorFrame(frame.payload)).toBe('abc123');
  });

  test('exit round-trips a code, and distinguishes absent from zero', () => {
    expect(decodeExitFrame(one(encodeExitFrame(137)).payload)).toBe(137);
    expect(decodeExitFrame(one(encodeExitFrame(0)).payload)).toBe(0);
    expect(decodeExitFrame(one(encodeExitFrame()).payload)).toBeUndefined();
  });

  test('title round-trips, unicode included', () => {
    const frame = one(encodeTitleFrame('~/sites/tether — bun'));
    expect(frame.kind).toBe(FrameKind.TITLE);
    expect(decodeTitleFrame(frame.payload)).toBe('~/sites/tether — bun');
  });

  test('activity round-trips every value', () => {
    for (const activity of ['working', 'waiting', 'idle'] as const) {
      const frame = one(encodeActivityFrame(activity));
      expect(frame.kind).toBe(FrameKind.ACTIVITY);
      expect(decodeActivityFrame(frame.payload)).toBe(activity);
    }
  });

  test('diff round-trips the full summary and status', () => {
    const summary = {
      files: [
        { path: 'a.ts', insertions: 3, deletions: 1, binary: false, staged: true },
        { path: 'b.png', insertions: 0, deletions: 0, binary: true },
      ],
    };
    const status = {
      branch: 'main',
      shortSha: 'deadbee',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
    };
    const frame = one(encodeDiffFrame(summary, status));
    expect(frame.kind).toBe(FrameKind.DIFF);
    expect(decodeDiffFrame(frame.payload)).toEqual({ summary, status });
  });

  test('diff keeps a null upstream null and an omitted status absent', () => {
    const status = {
      branch: 'wip',
      shortSha: 'abc1234',
      detached: true,
      upstream: null,
      ahead: 0,
      behind: 0,
    };
    const withStatus = decodeDiffFrame(one(encodeDiffFrame({ files: [] }, status)).payload);
    expect(withStatus.status).toEqual(status);
    expect(decodeDiffFrame(one(encodeDiffFrame({ files: [] })).payload).status).toBeNull();
  });

  test('reset and ping are empty-payload frames', () => {
    expect(one(encodeResetFrame()).kind).toBe(FrameKind.RESET);
    expect(one(encodeResetFrame()).payload.byteLength).toBe(0);
    expect(one(encodePingFrame()).kind).toBe(FrameKind.PING);
    expect(one(encodePingFrame()).payload.byteLength).toBe(0);
  });
});

describe('protocol v2 client -> server frames', () => {
  test('input round-trips, escape sequences intact', () => {
    const frame = one(encodeClientMessage({ type: 'input', text: '\x1b[A\r' }));
    expect(frame.kind).toBe(FrameKind.INPUT);
    expect(decodeClientFrame(frame)).toEqual({ type: 'input', text: '\x1b[A\r' });
  });

  test('resize round-trips', () => {
    const frame = one(encodeClientMessage({ type: 'resize', cols: 213, rows: 61 }));
    expect(decodeClientFrame(frame)).toEqual({ type: 'resize', cols: 213, rows: 61 });
  });

  test('focus round-trips both states', () => {
    for (const focused of [true, false]) {
      const frame = one(encodeClientMessage({ type: 'focus', focused }));
      expect(decodeClientFrame(frame)).toEqual({ type: 'focus', focused });
    }
  });

  test('an unknown kind decodes to null rather than throwing', () => {
    expect(decodeClientFrame({ kind: 250, payload: new Uint8Array() })).toBeNull();
    // A server->client kind arriving from a client is also not a client message.
    expect(decodeClientFrame({ kind: FrameKind.OUTPUT, payload: new Uint8Array() })).toBeNull();
  });
});
