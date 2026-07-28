import { expect, test } from 'bun:test';
import {
  hostHealthAfterFailure,
  hostHealthAfterResponse,
  initialHostHealth,
  nextHostPollDelay,
  shouldPollHost,
} from './hostHealth';

test('transitions unknown and unreachable hosts to reachable after a successful response', () => {
  expect(hostHealthAfterResponse(initialHostHealth(), 200)).toEqual({
    status: 'reachable',
    failures: 0,
  });
  expect(hostHealthAfterResponse({ status: 'unreachable', failures: 3 }, 204)).toEqual({
    status: 'reachable',
    failures: 0,
  });
});

test('marks a 401 unauthorized and stops future polling', () => {
  const health = hostHealthAfterResponse(initialHostHealth(), 401);
  expect(health).toEqual({ status: 'unauthorized', failures: 0 });
  expect(shouldPollHost(health)).toBeFalse();
  expect(nextHostPollDelay(health, 4_000)).toBeNull();
});

test('marks non-auth failures unreachable with exponential backoff capped at 30 seconds', () => {
  let health = initialHostHealth();
  health = hostHealthAfterFailure(health);
  expect(health).toEqual({ status: 'unreachable', failures: 1 });
  expect(nextHostPollDelay(health, 4_000)).toBe(2_000);
  health = hostHealthAfterFailure(health);
  expect(nextHostPollDelay(health, 4_000)).toBe(4_000);
  for (let attempt = 0; attempt < 10; attempt++) health = hostHealthAfterFailure(health);
  expect(nextHostPollDelay(health, 4_000)).toBe(30_000);
});

test('treats non-401 HTTP responses as unreachable and resets backoff on success', () => {
  const unreachable = hostHealthAfterResponse({ status: 'unreachable', failures: 2 }, 503);
  expect(unreachable).toEqual({ status: 'unreachable', failures: 3 });
  const reachable = hostHealthAfterResponse(unreachable, 200);
  expect(reachable).toEqual({ status: 'reachable', failures: 0 });
  expect(nextHostPollDelay(reachable, 15_000)).toBe(15_000);
});
