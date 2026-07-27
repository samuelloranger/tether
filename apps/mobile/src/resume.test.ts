import { RESUME_STALE_MS, resumeAction } from './resume';

const NOW = 1_000_000;

test('a closed socket reconnects immediately on resume', () => {
  expect(resumeAction({ open: false, lastSeen: NOW }, NOW)).toBe('reconnect');
  expect(resumeAction({ open: false, lastSeen: 0 }, NOW)).toBe('reconnect');
});

test('a socket silent across the suspension is treated as half-open', () => {
  expect(resumeAction({ open: true, lastSeen: NOW - RESUME_STALE_MS - 1 }, NOW)).toBe('close');
});

test('a healthy socket is left alone', () => {
  expect(resumeAction({ open: true, lastSeen: NOW - 1000 }, NOW)).toBe('none');
  expect(resumeAction({ open: true, lastSeen: NOW }, NOW)).toBe('none');
});
