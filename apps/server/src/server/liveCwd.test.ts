import { expect, test } from 'bun:test';
import {
  clearLiveCwd,
  getLiveCwd,
  INITIAL_LIVE_CWD_STATE,
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
