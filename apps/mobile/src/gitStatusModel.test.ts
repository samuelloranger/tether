import { expect, test } from 'bun:test';
import {
  canPushHead,
  canRewriteHead,
  formatRepoStatusLabel,
  parseRepoStatus,
} from './gitStatusModel';

test('formatRepoStatusLabel and canRewriteHead match server semantics', () => {
  expect(
    formatRepoStatusLabel({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
    }),
  ).toBe('main');
  expect(
    canRewriteHead({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    }),
  ).toBe(false);
});

test('canPushHead when ahead or no upstream', () => {
  const base = {
    branch: 'main',
    shortSha: 'abc',
    detached: false,
    upstream: 'origin/main' as string | null,
    ahead: 0,
    behind: 0,
  };
  expect(canPushHead({ ...base, ahead: 1 })).toBe(true);
  expect(canPushHead({ ...base, ahead: 0 })).toBe(false);
  expect(canPushHead({ ...base, upstream: null, ahead: 0 })).toBe(true);
  expect(canPushHead({ ...base, detached: true, ahead: 1 })).toBe(false);
});

test('parseRepoStatus rejects malformed payloads', () => {
  expect(parseRepoStatus(null)).toBeNull();
  expect(parseRepoStatus({ branch: 'main' })).toBeNull();
  expect(
    parseRepoStatus({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: null,
      ahead: 1,
      behind: 0,
    }),
  ).toEqual({
    branch: 'main',
    shortSha: 'abc',
    detached: false,
    upstream: null,
    ahead: 1,
    behind: 0,
  });
});
