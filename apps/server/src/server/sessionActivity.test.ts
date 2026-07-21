import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearActivity,
  getActivity,
  recordInput,
  recordOutput,
  SILENCE_MS,
  scanChunk,
} from './sessionActivity';

const T0 = 1_000_000;

describe('scanChunk', () => {
  test('bare BEL is an attention bell', () => {
    const r = scanChunk('', 'done\x07');
    expect(r.bell).toBe(true);
    expect(r.tail).toBe('done');
  });

  test('BEL terminating an OSC string is NOT a bell', () => {
    const r = scanChunk('', '\x1b]7;file://host/home/sam\x07hello');
    expect(r.bell).toBe(false);
    expect(r.tail).toBe('hello');
  });

  test('OSC 9 notification detected', () => {
    const r = scanChunk('', '\x1b]9;build finished\x07');
    expect(r.notify).toBe(true);
  });

  test('OSC 777;notify detected (ST-terminated)', () => {
    const r = scanChunk('', '\x1b]777;notify;title;body\x1b\\');
    expect(r.notify).toBe(true);
  });

  test('OSC 133 prompt marks parsed', () => {
    expect(scanChunk('', '\x1b]133;A\x07').promptMark).toBe('A');
    expect(scanChunk('', '\x1b]133;C\x07').promptMark).toBe('C');
  });

  test('OSC split across chunks carries residual and never counts interior BEL late', () => {
    const a = scanChunk('', 'out\x1b]7;file://h/tmp');
    expect(a.residual).toStartWith('\x1b]');
    expect(a.tail).toBe('out');
    const b = scanChunk(a.residual, '\x07more');
    expect(b.bell).toBe(false);
    expect(b.tail).toBe('more');
  });

  test('CSI sequences are stripped from the visible tail', () => {
    const r = scanChunk('', '\x1b[31mError:\x1b[0m boom');
    expect(r.tail).toBe('Error: boom');
  });

  test('CSI split across chunks resumes cleanly', () => {
    const a = scanChunk('', 'x\x1b[38;5;');
    expect(a.residual).toStartWith('\x1b[');
    const b = scanChunk(a.residual, '2mY');
    expect(b.tail).toBe('Y');
  });

  test('tail is the last non-empty line, CR treated as line break', () => {
    const r = scanChunk('', 'first\nsecond\r\n  Do you want to proceed? \n');
    expect(r.tail).toBe('Do you want to proceed?');
  });

  test('trailing bare ESC becomes residual', () => {
    const r = scanChunk('', 'abc\x1b');
    expect(r.residual).toBe('\x1b');
    expect(r.tail).toBe('abc');
  });
});

describe('activity state machine', () => {
  afterEach(() => clearActivity('s'));

  test('unknown session reads as null', () => {
    expect(getActivity('nope', T0)).toBeNull();
  });

  test('plain output → working', () => {
    expect(recordOutput('s', 'compiling…\n', T0)).toBe('working');
    expect(getActivity('s', T0)).toBe('working');
  });

  test('bell → waiting; further output flips back to working', () => {
    recordOutput('s', 'building\n', T0);
    expect(recordOutput('s', 'Allow this tool? \x07', T0 + 1000)).toBe('waiting');
    expect(getActivity('s', T0 + 2000)).toBe('waiting');
    expect(recordOutput('s', 'running tool…\n', T0 + 3000)).toBe('working');
  });

  test('user input clears waiting', () => {
    recordOutput('s', 'ok? \x07', T0);
    expect(getActivity('s', T0)).toBe('waiting');
    expect(recordInput('s', T0 + 500)).toBe('working');
    expect(getActivity('s', T0 + 500)).toBe('working');
  });

  test('input while already working is a no-op', () => {
    recordOutput('s', 'hi\n', T0);
    expect(recordInput('s', T0 + 1)).toBeNull();
  });

  test('OSC 133;A → idle, 133;C → working', () => {
    recordOutput('s', 'out\n', T0);
    expect(recordOutput('s', '\x1b]133;A\x07$ ', T0 + 10)).toBe('idle');
    expect(recordOutput('s', '\x1b]133;C\x07', T0 + 20)).toBe('working');
  });

  test('silence + question tail reads as waiting (lazy heuristic)', () => {
    recordOutput('s', 'Do you want to proceed? (y/n) ', T0);
    // fresh output → still working…
    expect(getActivity('s', T0 + 1000)).toBe('working');
    // …until silence passes the threshold
    expect(getActivity('s', T0 + SILENCE_MS)).toBe('waiting');
  });

  test('silence + shell-prompt tail reads as idle', () => {
    recordOutput('s', 'sam@host:~/sites $ ', T0);
    expect(getActivity('s', T0 + SILENCE_MS)).toBe('idle');
  });

  test('silence with non-prompt tail stays working (quiet long job)', () => {
    recordOutput('s', 'downloading model weights…', T0);
    expect(getActivity('s', T0 + SILENCE_MS)).toBe('working');
  });

  test('pure escape chunk does not flip waiting back to working', () => {
    recordOutput('s', 'ok? \x07', T0);
    expect(recordOutput('s', '\x1b[?25h', T0 + 100)).toBeNull();
    expect(getActivity('s', T0 + 200)).toBe('waiting');
  });

  test('clearActivity forgets the session', () => {
    recordOutput('s', 'x', T0);
    clearActivity('s');
    expect(getActivity('s', T0)).toBeNull();
  });
});
