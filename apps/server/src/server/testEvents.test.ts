import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testEvent } from './testEvents';

let dir: string;
const prev = process.env.TETHER_TEST_LOG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-evt-'));
});
afterEach(() => {
  if (prev === undefined) delete process.env.TETHER_TEST_LOG;
  else process.env.TETHER_TEST_LOG = prev;
  rmSync(dir, { recursive: true, force: true });
});

test('does nothing when TETHER_TEST_LOG is unset', () => {
  delete process.env.TETHER_TEST_LOG;
  expect(() => testEvent('noise_start', { session: 's1' })).not.toThrow();
});

test('appends one JSON line per event with ev, fields, and a ts', () => {
  const sink = join(dir, 'evt.log');
  process.env.TETHER_TEST_LOG = sink;

  testEvent('ws_open', { session: 's1', sinceId: 0 });
  testEvent('noise_input', { session: 's1', bytes: 3 });

  const lines = readFileSync(sink, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);

  const first = JSON.parse(lines[0]);
  expect(first.ev).toBe('ws_open');
  expect(first.session).toBe('s1');
  expect(first.sinceId).toBe(0);
  expect(typeof first.ts).toBe('number');

  const second = JSON.parse(lines[1]);
  expect(second.ev).toBe('noise_input');
  expect(second.bytes).toBe(3);
});

test('swallows write errors to an unwritable sink', () => {
  process.env.TETHER_TEST_LOG = join(dir, 'no-such-dir', 'evt.log');
  expect(() => testEvent('sigwinch', { session: 's1' })).not.toThrow();
});
