import { expect, test } from 'bun:test';
import {
  clearLiveCwd,
  getLiveCwd,
  INITIAL_LIVE_CWD_STATE,
  normalizeOsc7Cwd,
  recordChunk,
  reportCwd,
  updateLiveCwd,
} from './liveCwd';

test('reportCwd sets the live cwd directly, without needing an OSC 7 report', () => {
  const id = 'report-cwd-direct';
  reportCwd(id, '/home/sam/project');
  expect(getLiveCwd(id)).toBe('/home/sam/project');
  clearLiveCwd(id);
});

test('parses a complete OSC 7 cwd report', () => {
  const chunk = '\x1b]7;file://myhost/home/sam/project\x07';
  const state = updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk);
  expect(state.cwd).toBe('/home/sam/project');
  expect(state.residual).toBe('');
});

test('decodes percent-escaped paths', () => {
  const chunk = '\x1b]7;file://myhost/home/sam/My%20Project\x07';
  expect(updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk).cwd).toBe('/home/sam/My Project');
});

test('keeps the previous cwd when a chunk has no OSC 7 report', () => {
  const first = updateLiveCwd(INITIAL_LIVE_CWD_STATE, '\x1b]7;file://h/a\x07');
  const second = updateLiveCwd(first, 'plain shell output, no escapes\n');
  expect(second.cwd).toBe('/a');
});

test('keeps the last report when a chunk has multiple cd reports', () => {
  const chunk = '\x1b]7;file://h/a\x07some output\x1b]7;file://h/b\x07';
  expect(updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk).cwd).toBe('/b');
});

test('reassembles an OSC 7 report split across two chunks', () => {
  const whole = '\x1b]7;file://h/home/sam/project\x07';
  const first = updateLiveCwd(INITIAL_LIVE_CWD_STATE, whole.slice(0, 15));
  expect(first.cwd).toBeNull();
  const second = updateLiveCwd(first, whole.slice(15));
  expect(second.cwd).toBe('/home/sam/project');
});

test('discards unrelated but complete OSC sequences (e.g. a title update)', () => {
  const state = updateLiveCwd(INITIAL_LIVE_CWD_STATE, '\x1b]0;some title\x07');
  expect(state.cwd).toBeNull();
  expect(state.residual).toBe('');
});

test('recordChunk/getLiveCwd/clearLiveCwd track state per session id', () => {
  recordChunk('live-cwd-session', '\x1b]7;file://h/a/b\x07');
  expect(getLiveCwd('live-cwd-session')).toBe('/a/b');
  clearLiveCwd('live-cwd-session');
  expect(getLiveCwd('live-cwd-session')).toBeNull();
});

// --- Windows: a file URI path is not a native path -------------------------
// The URI is always rooted at "/", so a Windows cwd arrives as "/C:/Users/x".
// The leading slash is URI syntax and the separators depend on which shell
// emitted it (our PowerShell profile writes "/", cmd.exe's $P writes "\").

test('normalizeOsc7Cwd converts a Windows file-URI path to a native path', () => {
  expect(normalizeOsc7Cwd('/C:/Users/sam/project', true)).toBe(String.raw`C:\Users\sam\project`);
});

test('normalizeOsc7Cwd accepts the backslashes cmd.exe $P emits', () => {
  expect(normalizeOsc7Cwd(String.raw`/C:\Users\sam\project`, true)).toBe(
    String.raw`C:\Users\sam\project`,
  );
});

test('normalizeOsc7Cwd keeps a drive root intact', () => {
  expect(normalizeOsc7Cwd('/D:/', true)).toBe('D:\\');
});

test('normalizeOsc7Cwd leaves POSIX paths untouched on POSIX', () => {
  expect(normalizeOsc7Cwd('/home/sam/project', false)).toBe('/home/sam/project');
});

test('normalizeOsc7Cwd leaves a non-drive path alone even on Windows', () => {
  // A Git Bash / WSL shell reports MSYS-style paths that have no drive letter;
  // rewriting separators there would produce a path Windows cannot resolve.
  expect(normalizeOsc7Cwd('/c/Users/sam', true)).toBe('/c/Users/sam');
});

test('an OSC 7 report from a Windows shell lands as a native cwd', () => {
  const id = 'win-osc7-cwd';
  const state = updateLiveCwd(
    INITIAL_LIVE_CWD_STATE,
    '\x1b]7;file://myhost/C:/Users/sam/project\x07',
  );
  expect(state.reported).toBe(true);
  // Platform-dependent by design: the same bytes mean a native path on Windows
  // and are left verbatim elsewhere.
  expect(state.cwd).toBe(
    process.platform === 'win32' ? String.raw`C:\Users\sam\project` : '/C:/Users/sam/project',
  );
  clearLiveCwd(id);
});
