import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearActivity,
  getActivity,
  isAgentDriven,
  recordInput,
  recordOutput,
  recordOutputEvent,
  recordSignal,
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
    expect(r.notify).toEqual({ body: 'build finished' });
  });

  test('OSC 777;notify detected (ST-terminated)', () => {
    const r = scanChunk('', '\x1b]777;notify;title;body\x1b\\');
    expect(r.notify).toEqual({ title: 'title', body: 'body' });
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

  test('heuristic waiting is committed: input clears it, output broadcasts working', () => {
    recordOutput('s', 'Do you want to proceed? (y/n) ', T0);
    expect(getActivity('s', T0 + SILENCE_MS)).toBe('waiting');
    // The read committed the reclassification, so input now clears it…
    expect(recordInput('s', T0 + SILENCE_MS + 1)).toBe('working');
    // …and from a committed heuristic `waiting`, fresh output is a real transition.
    recordOutput('s', 'ok? [y/N] ', T0 + SILENCE_MS + 2);
    expect(getActivity('s', T0 + 2 * SILENCE_MS + 2)).toBe('waiting');
    expect(recordOutput('s', 'proceeding…\n', T0 + 2 * SILENCE_MS + 3)).toBe('working');
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

describe('done state', () => {
  afterEach(() => {
    clearActivity('d1');
    clearActivity('d2');
    clearActivity('d3');
  });

  test('an OSC-sourced waiting settles to done once it is quiet and asks nothing', () => {
    recordOutput('d1', 'building\n', T0);
    recordOutput('d1', '\x1b]777;notify;Claude;Finished\x07', T0 + 100);
    expect(getActivity('d1', T0 + 200)).toBe('waiting');
    expect(getActivity('d1', T0 + 100 + SILENCE_MS)).toBe('done');
  });

  test('an OSC-sourced waiting that DOES ask something stays waiting', () => {
    recordOutput('d2', 'Do you want to proceed?\x07', T0);
    expect(getActivity('d2', T0 + SILENCE_MS)).toBe('waiting');
  });

  test('a tail-sourced waiting never decays', () => {
    recordOutput('d3', 'Continue? ', T0);
    expect(getActivity('d3', T0 + SILENCE_MS)).toBe('waiting');
    expect(getActivity('d3', T0 + SILENCE_MS * 4)).toBe('waiting');
  });

  test('typing does not disturb a done session, but its echo does', () => {
    recordOutput('d1', 'x\x07', T0);
    expect(getActivity('d1', T0 + SILENCE_MS)).toBe('done');
    // recordInput only answers a `waiting`. A finished session is not a
    // question, so there is nothing for a keystroke to answer.
    expect(recordInput('d1', T0 + SILENCE_MS + 1)).toBeNull();
    expect(recordOutput('d1', 'x', T0 + SILENCE_MS + 2)).toBe('working');
  });

  test('a done session that reaches a shell prompt goes idle', () => {
    recordOutput('d2', 'x\x07', T0);
    expect(getActivity('d2', T0 + SILENCE_MS)).toBe('done');
    recordOutput('d2', '\nsam@box ~ $ ', T0 + SILENCE_MS + 1);
    expect(getActivity('d2', T0 + SILENCE_MS * 3)).toBe('idle');
  });
});

describe('recordSignal', () => {
  afterEach(() => {
    clearActivity('s1');
    clearActivity('s2');
    clearActivity('s3');
  });

  test('a signal sets the state and reports the transition', () => {
    recordOutput('s1', 'work\n', T0);
    expect(recordSignal('s1', 'done', T0 + 10)).toBe('done');
    expect(getActivity('s1', T0 + 20)).toBe('done');
  });

  test('a signal for the same state is not a transition', () => {
    recordSignal('s1', 'done', T0);
    expect(recordSignal('s1', 'done', T0 + 10)).toBeNull();
  });

  test('once a session has signalled, a bell no longer forces waiting', () => {
    recordSignal('s2', 'done', T0);
    recordOutput('s2', '\x07', T0 + 10);
    expect(getActivity('s2', T0 + 20)).toBe('done');
  });

  test('once a session has signalled, silence stops being read as a question', () => {
    recordOutput('s3', 'Continue? ', T0);
    recordSignal('s3', 'working', T0 + 1);
    expect(getActivity('s3', T0 + SILENCE_MS * 2)).toBe('working');
  });

  test('output does NOT undo an agent-driven session own state', () => {
    // The whole point of the latch. A full-screen agent redraws constantly —
    // including right after its own Stop hook — so if a redraw counted as work
    // the `done` it just signalled would survive about one frame.
    recordSignal('s1', 'done', T0);
    expect(recordOutput('s1', 'more output\n', T0 + 10)).toBeNull();
    expect(getActivity('s1', T0 + 20)).toBe('done');
  });

  test('a real Claude Code TUI redraw does not clobber a signalled done', () => {
    // Captured verbatim from a live session terminal_logs row.
    const frame =
      '\x1b[?25l\x1b[2D\x1b[5B\r\x1b[9A\x1b[38;2;153;153;153m\u25cf\x1b[3G\x1b[39m' +
      '\x1b[1mBash\x1b[22m(ls)\r\n\x1b[2C\x1b[5A\x1b[?25h';
    recordSignal('s2', 'done', T0);
    recordOutput('s2', frame, T0 + 50);
    expect(getActivity('s2', T0 + 60)).toBe('done');
  });

  test('the prompt-submit hook is what re-lights it', () => {
    recordSignal('s3', 'done', T0);
    expect(recordSignal('s3', 'working', T0 + 10)).toBe('working');
  });

  test('a signalled waiting never decays', () => {
    recordSignal('s2', 'waiting', T0);
    expect(getActivity('s2', T0 + SILENCE_MS * 4)).toBe('waiting');
  });

  test('a shell prompt releases the latch, so the session can go quiet again', () => {
    recordSignal('s3', 'done', T0);
    expect(isAgentDriven('s3')).toBe(true);
    recordOutput('s3', '\nsam@box ~ $ ', T0 + 10);
    expect(getActivity('s3', T0 + SILENCE_MS * 2)).toBe('idle');
    expect(isAgentDriven('s3')).toBe(false);
  });

  test('an OSC 133 prompt mark releases the latch, like a prompt in the tail does', () => {
    // A shell that emits semantic prompt marks reaches `idle` through a
    // different branch than the tail regex. It has to release the latch too,
    // or the session stays agent-driven forever and every later bell from an
    // unrelated command is swallowed.
    recordSignal('s3', 'done', T0);
    expect(isAgentDriven('s3')).toBe(true);
    expect(recordOutput('s3', '\x1b]133;A\x07', T0 + 10)).toBe('idle');
    expect(isAgentDriven('s3')).toBe(false);
    // And the proof it matters: a bell is heard again.
    recordOutput('s3', 'oops\x07', T0 + 20);
    expect(getActivity('s3', T0 + 30)).toBe('waiting');
  });

  test('an agent-driven session stops raising its duplicate OSC push', () => {
    // The whole bug: Claude Code emits OSC 777 when it FINISHES, and
    // ptyHolder turns any notify payload into an oscNotify push. Once the
    // program has its own signal channel that push is a duplicate of the
    // signal, and it is the one the user actually complained about.
    const before = recordOutputEvent('s1', '\x1b]777;notify;Claude;Finished\x07', T0);
    expect(before.notify).not.toBeNull();
    clearActivity('s1');
    recordSignal('s1', 'done', T0);
    const after = recordOutputEvent('s1', '\x1b]777;notify;Claude;Finished\x07', T0 + 10);
    expect(after.notify).toBeNull();
  });
});
