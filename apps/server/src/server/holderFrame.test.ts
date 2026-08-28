import { describe, expect, test } from 'bun:test';
import {
  decodeHolderFrame,
  decodeLegacyHolderLine,
  encodeHolderCwd,
  encodeHolderCwdRequest,
  encodeHolderExit,
  encodeHolderHello,
  encodeHolderInput,
  encodeHolderKill,
  encodeHolderOutput,
  encodeHolderResize,
  encodeLegacyHolderFrame,
  HOLDER_PROTO_VERSION,
  HolderKind,
  LEGACY_FIRST_BYTE,
  sniffDialect,
  takeLegacyLines,
} from './holderFrame';
import { isInterruptKeystroke } from './holder';
import { FrameDecoder } from './proto/frame';

const one = (bytes: Uint8Array) => {
  const frames = new FrameDecoder().push(bytes);
  expect(frames).toHaveLength(1);
  return frames[0];
};
const decode = (bytes: Uint8Array) => decodeHolderFrame(one(bytes));

describe('binary holder frames', () => {
  test('input round-trips raw bytes with no base64', () => {
    const frame = one(encodeHolderInput('ls -la\r'));
    expect(frame.kind).toBe(HolderKind.INPUT);
    expect(frame.payload.byteLength).toBe(7); // not 12, which is what base64 cost
    expect(decodeHolderFrame(frame)).toEqual({
      type: 'input',
      data: new TextEncoder().encode('ls -la\r'),
    });
  });

  test('output round-trips bytes a JSON dialect could not carry', () => {
    const raw = new Uint8Array([0x00, 0x1b, 0x5b, 0x41, 0x0a, 0xff, 0xfe]);
    const msg = decode(encodeHolderOutput(raw));
    expect(msg).toEqual({ type: 'output', data: raw });
  });

  test('output of a partial UTF-8 sequence survives intact', () => {
    // The server decodes output with a streaming TextDecoder, so a multi-byte
    // character split across two frames must arrive byte-exact.
    const emoji = new TextEncoder().encode('🙂');
    const head = decode(encodeHolderOutput(emoji.slice(0, 2)));
    const tail = decode(encodeHolderOutput(emoji.slice(2)));
    expect(head).toEqual({ type: 'output', data: emoji.slice(0, 2) });
    expect(tail).toEqual({ type: 'output', data: emoji.slice(2) });
  });

  test('resize round-trips, and clamps out-of-range dims', () => {
    expect(decode(encodeHolderResize(213, 61))).toEqual({ type: 'resize', cols: 213, rows: 61 });
    expect(decode(encodeHolderResize(80.9, 24.9))).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(decode(encodeHolderResize(-5, 999_999))).toEqual({
      type: 'resize',
      cols: 0,
      rows: 0xffff,
    });
  });

  test('kill is an empty frame', () => {
    expect(one(encodeHolderKill()).payload.byteLength).toBe(0);
    expect(decode(encodeHolderKill())).toEqual({ type: 'kill' });
  });

  test('hello carries the protocol version', () => {
    expect(decode(encodeHolderHello())).toEqual({
      type: 'hello',
      version: HOLDER_PROTO_VERSION,
    });
    expect(decode(encodeHolderHello(9))).toEqual({ type: 'hello', version: 9 });
  });

  test('exit distinguishes a code from no code at all', () => {
    expect(decode(encodeHolderExit(0))).toEqual({ type: 'exit', exitCode: 0 });
    expect(decode(encodeHolderExit(137))).toEqual({ type: 'exit', exitCode: 137 });
    expect(decode(encodeHolderExit(-1))).toEqual({ type: 'exit', exitCode: -1 });
    expect(decode(encodeHolderExit())).toEqual({ type: 'exit' });
    expect(decode(encodeHolderExit(null))).toEqual({ type: 'exit' });
  });

  test('cwd round-trips a unicode path', () => {
    expect(decode(encodeHolderCwd('/home/té/sites'))).toEqual({
      type: 'cwd',
      cwd: '/home/té/sites',
    });
  });

  test('an unknown kind decodes to null, not a throw', () => {
    expect(decodeHolderFrame({ kind: 200, payload: new Uint8Array() })).toBeNull();
  });

  test('a truncated resize payload is rejected', () => {
    expect(decodeHolderFrame({ kind: HolderKind.RESIZE, payload: new Uint8Array(2) })).toBeNull();
  });
});

describe('dialect sniffing', () => {
  test("legacy frames start with '{' and binary frames never can", () => {
    expect(sniffDialect(LEGACY_FIRST_BYTE)).toBe('legacy');
    expect(sniffDialect('{'.charCodeAt(0))).toBe('legacy');
    for (const kind of Object.values(HolderKind)) {
      expect(kind).not.toBe(LEGACY_FIRST_BYTE);
      expect(sniffDialect(kind)).toBe('binary');
    }
  });

  test('every encoder emits a first byte that sniffs as binary', () => {
    const frames = [
      encodeHolderInput('x'),
      encodeHolderResize(80, 24),
      encodeHolderKill(),
      encodeHolderHello(),
      encodeHolderOutput(new Uint8Array([1])),
      encodeHolderExit(0),
      encodeHolderCwd('/tmp'),
    ];
    for (const frame of frames) expect(sniffDialect(frame[0])).toBe('binary');
  });

  test('every legacy encoder emits a first byte that sniffs as legacy', () => {
    for (const msg of [
      { type: 'input', data: new Uint8Array([1]) },
      { type: 'resize', cols: 80, rows: 24 },
      { type: 'kill' },
    ] as const) {
      const line = encodeLegacyHolderFrame(msg);
      expect(line).not.toBeNull();
      expect(sniffDialect((line as string).charCodeAt(0))).toBe('legacy');
    }
  });
});

describe('legacy dialect', () => {
  test('decodes the frames a pre-v2 holder sends', () => {
    expect(decodeLegacyHolderLine('{"t":"o","d":"aGk="}')).toEqual({
      type: 'output',
      data: Buffer.from('hi'),
    });
    expect(decodeLegacyHolderLine('{"t":"c","d":"/tmp"}')).toEqual({ type: 'cwd', cwd: '/tmp' });
    expect(decodeLegacyHolderLine('{"t":"x","code":3}')).toEqual({ type: 'exit', exitCode: 3 });
    expect(decodeLegacyHolderLine('{"t":"x"}')).toEqual({ type: 'exit', exitCode: undefined });
  });

  test('decodes the frames a pre-v2 holder accepts', () => {
    expect(decodeLegacyHolderLine('{"t":"i","d":"bHM="}')).toEqual({
      type: 'input',
      data: Buffer.from('ls'),
    });
    expect(decodeLegacyHolderLine('{"t":"r","c":100,"r":30}')).toEqual({
      type: 'resize',
      cols: 100,
      rows: 30,
    });
    expect(decodeLegacyHolderLine('{"t":"k"}')).toEqual({ type: 'kill' });
  });

  test('junk and unknown tags decode to null', () => {
    expect(decodeLegacyHolderLine('not json')).toBeNull();
    expect(decodeLegacyHolderLine('{"t":"z"}')).toBeNull();
    expect(decodeLegacyHolderLine('{"t":"o"}')).toBeNull();
  });

  test('re-encodes exactly what a pre-v2 holder parses', () => {
    expect(encodeLegacyHolderFrame({ type: 'input', data: Buffer.from('ls') })).toBe(
      '{"t":"i","d":"bHM="}\n',
    );
    expect(encodeLegacyHolderFrame({ type: 'resize', cols: 100, rows: 30 })).toBe(
      '{"t":"r","c":100,"r":30}\n',
    );
    expect(encodeLegacyHolderFrame({ type: 'kill' })).toBe('{"t":"k"}\n');
    // Nothing the server never sends is expressible.
    expect(encodeLegacyHolderFrame({ type: 'hello', version: 2 })).toBeNull();
  });

  test('line splitting keeps a partial tail', () => {
    expect(takeLegacyLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
    expect(takeLegacyLines('')).toEqual({ lines: [], rest: '' });
    expect(takeLegacyLines('\n\n')).toEqual({ lines: [], rest: '' });
  });
});

test('CWDREQ round-trips and carries no payload', () => {
  const decoded = decode(encodeHolderCwdRequest());
  expect(decoded).toEqual({ type: 'cwdRequest' });
});

test('the legacy dialect cannot express a cwd request', () => {
  // A pre-v2 holder has never heard of the frame, so there is nothing to send
  // it — the caller must treat "no answer" as normal rather than as a failure.
  expect(encodeLegacyHolderFrame({ type: 'cwdRequest' })).toBeNull();
});

const ETX = 0x03;

describe('isInterruptKeystroke', () => {
  test('true for a lone Ctrl+C byte', () => {
    expect(isInterruptKeystroke(new Uint8Array([ETX]))).toBe(true);
  });

  test('false for an empty chunk', () => {
    expect(isInterruptKeystroke(new Uint8Array([]))).toBe(false);
  });

  test('false for ordinary input', () => {
    expect(isInterruptKeystroke(new TextEncoder().encode('ls -la\n'))).toBe(false);
  });

  test('false for a paste that happens to carry a 0x03 byte', () => {
    // The regression: a multi-byte buffer containing ETX must not read as an
    // interrupt, or a paste would taskkill the foreground job.
    expect(isInterruptKeystroke(new Uint8Array([0x61, ETX, 0x62]))).toBe(false);
    expect(isInterruptKeystroke(new Uint8Array([ETX, ETX]))).toBe(false);
  });
});
