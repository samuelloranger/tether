import { describe, expect, test } from 'bun:test';
import { FrameDecoder } from '../proto/frame';
import {
  decodeCursorFrame,
  decodeExitFrame,
  decodeTitleFrame,
  encodeClientMessage,
  FrameKind,
} from '../proto/wireCodec';
import { encodeReplayCursor } from '../replayCursor';
import { codecFor } from './terminalCodec';

const SUMMARY = { files: [{ path: 'a.ts', insertions: 1, deletions: 0, binary: false }] };
const STATUS = {
  branch: 'main',
  shortSha: 'abc1234',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
};

describe('proto=1 (JSON) is byte-identical to the shipped protocol', () => {
  const codec = codecFor(null, 'default');

  test('an absent or unrecognized proto selects v1', () => {
    expect(codecFor(null, 'x').proto).toBe(1);
    expect(codecFor('1', 'x').proto).toBe(1);
    expect(codecFor('9', 'x').proto).toBe(1);
    expect(codecFor('', 'x').proto).toBe(1);
  });

  test('live output keeps its exact key order', () => {
    expect(codec.liveOutput('hi\r\n', 42)).toBe('{"type":"output","chunk":"hi\\r\\n","id":42}');
  });

  test('replay output keeps its exact key order', () => {
    expect(codec.replayOutput({ type: 'output', id: 7, chunk: 'x' })).toBe(
      '{"type":"output","id":7,"chunk":"x"}',
    );
  });

  test('exit omits exitCode when there is none', () => {
    expect(codec.exit(130)).toBe('{"type":"exit","exitCode":130}');
    expect(codec.exit()).toBe('{"type":"exit"}');
  });

  test('activity, reset and ping are unchanged', () => {
    expect(codec.activity('waiting')).toBe('{"type":"activity","activity":"waiting"}');
    expect(codec.reset()).toBe('{"type":"reset"}');
    expect(codec.ping()).toBe('{"type":"ping"}');
  });

  test('diff keeps summary before status', () => {
    expect(codec.diff(SUMMARY, STATUS)).toBe(
      JSON.stringify({ type: 'diff', summary: SUMMARY, status: STATUS }),
    );
  });

  test('v1 sends no title frame — it never did', () => {
    expect(codec.title('anything')).toBeNull();
  });

  test('client messages decode as before', () => {
    expect(codec.decode('{"type":"input","text":"ls"}')).toEqual([{ type: 'input', text: 'ls' }]);
    expect(codec.decode('{"type":"resize","cols":"120","rows":"40"}')).toEqual([
      { type: 'resize', cols: 120, rows: 40 },
    ]);
    expect(codec.decode('{"type":"focus","focused":false}')).toEqual([
      { type: 'focus', focused: false },
    ]);
    expect(codec.decode('{"type":"input","text":42}')).toEqual([]);
    expect(codec.decode('{"type":"nope"}')).toEqual([]);
  });

  test('replay still starts from the integer sinceId', () => {
    expect(codec.replayFrom({ sinceId: '910', cursor: null }, 'default')).toBe(910);
    expect(codec.replayFrom({ sinceId: null, cursor: null }, 'default')).toBe(0);
    // A v2 cursor is meaningless to v1 and must not be consulted.
    expect(
      codec.replayFrom({ sinceId: null, cursor: encodeReplayCursor('default', 5) }, 'default'),
    ).toBe(0);
  });
});

describe('proto=2 (binary)', () => {
  const codec = codecFor('2', 'default');
  const frames = (data: string | Uint8Array) => {
    expect(typeof data).not.toBe('string');
    return new FrameDecoder().push(data as Uint8Array);
  };

  test('selected by proto=2', () => {
    expect(codec.proto).toBe(2);
  });

  test('output is raw bytes followed by its cursor, in one write', () => {
    const [output, cursor] = frames(codec.liveOutput('\x1b[2J', 88));
    expect(output.kind).toBe(FrameKind.OUTPUT);
    expect(new TextDecoder().decode(output.payload)).toBe('\x1b[2J');
    expect(cursor.kind).toBe(FrameKind.CURSOR);
    // Opaque to the client, but this server can read its own cursor back.
    expect(decodeCursorFrame(cursor.payload)).toBe(encodeReplayCursor('default', 88));
  });

  test('replay output also carries its cursor', () => {
    const [output, cursor] = frames(codec.replayOutput({ type: 'output', id: 3, chunk: 'ok' }));
    expect(new TextDecoder().decode(output.payload)).toBe('ok');
    expect(decodeCursorFrame(cursor.payload)).toBe(encodeReplayCursor('default', 3));
  });

  test('a cursor never leaks the row id', () => {
    const [, cursor] = frames(codec.liveOutput('x', 4210));
    expect(decodeCursorFrame(cursor.payload)).not.toContain('4210');
  });

  test('structural frames use their own kinds', () => {
    expect(frames(codec.exit(1))[0].kind).toBe(FrameKind.EXIT);
    expect(decodeExitFrame(frames(codec.exit(1))[0].payload)).toBe(1);
    expect(decodeExitFrame(frames(codec.exit())[0].payload)).toBeUndefined();
    expect(frames(codec.activity('idle'))[0].kind).toBe(FrameKind.ACTIVITY);
    expect(frames(codec.diff(SUMMARY, STATUS))[0].kind).toBe(FrameKind.DIFF);
    expect(frames(codec.reset())[0].kind).toBe(FrameKind.RESET);
    expect(frames(codec.ping())[0].kind).toBe(FrameKind.PING);
  });

  test('v2 does carry title frames', () => {
    const frame = codec.title('~/sites/tether');
    expect(frame).not.toBeNull();
    const [decoded] = frames(frame as Uint8Array);
    expect(decoded.kind).toBe(FrameKind.TITLE);
    expect(decodeTitleFrame(decoded.payload)).toBe('~/sites/tether');
  });

  test('decodes a client frame', () => {
    expect(codec.decode(encodeClientMessage({ type: 'input', text: 'ls\r' }))).toEqual([
      { type: 'input', text: 'ls\r' },
    ]);
  });

  test('decodes several client frames packed into one message', () => {
    const packed = Buffer.concat([
      encodeClientMessage({ type: 'resize', cols: 100, rows: 30 }),
      encodeClientMessage({ type: 'focus', focused: true }),
    ]);
    expect(codec.decode(new Uint8Array(packed))).toEqual([
      { type: 'resize', cols: 100, rows: 30 },
      { type: 'focus', focused: true },
    ]);
  });

  test('reassembles a client frame split across two messages', () => {
    const split = codecFor('2', 'default');
    const frame = encodeClientMessage({ type: 'input', text: 'hello' });
    expect(split.decode(frame.slice(0, 4))).toEqual([]);
    expect(split.decode(frame.slice(4))).toEqual([{ type: 'input', text: 'hello' }]);
  });

  test('accepts an ArrayBuffer, as Bun hands binary messages over', () => {
    const frame = encodeClientMessage({ type: 'focus', focused: false });
    const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    expect(codecFor('2', 'default').decode(buf)).toEqual([{ type: 'focus', focused: false }]);
  });

  test('replay resumes from the opaque cursor, not from sinceId', () => {
    const cursor = encodeReplayCursor('default', 512);
    expect(codec.replayFrom({ sinceId: '999', cursor }, 'default')).toBe(512);
    // An integer sinceId is not a cursor: a v2 client gets the retained tail.
    expect(codec.replayFrom({ sinceId: '999', cursor: null }, 'default')).toBe(0);
    // Another session's cursor is refused rather than trusted.
    expect(
      codec.replayFrom({ sinceId: null, cursor: encodeReplayCursor('other', 512) }, 'default'),
    ).toBe(0);
  });
});
