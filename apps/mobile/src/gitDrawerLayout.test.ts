import { expect, test } from 'bun:test';
import {
  clampGitDrawerLeftWidth,
  defaultGitDrawerLeftWidth,
  GIT_DRAWER_DEFAULT_LEFT_RATIO,
  GIT_DRAWER_MIN_LEFT,
  GIT_DRAWER_MIN_RIGHT,
} from './gitDrawerLayout';

test('clampGitDrawerLeftWidth enforces min left and min right', () => {
  const total = 1200;
  expect(clampGitDrawerLeftWidth(50, total)).toBe(GIT_DRAWER_MIN_LEFT);
  expect(clampGitDrawerLeftWidth(1100, total)).toBe(total - GIT_DRAWER_MIN_RIGHT);
  expect(clampGitDrawerLeftWidth(400, total)).toBe(400);
});

test('clampGitDrawerLeftWidth splits narrow totals in half', () => {
  const total = GIT_DRAWER_MIN_LEFT + GIT_DRAWER_MIN_RIGHT - 40;
  expect(clampGitDrawerLeftWidth(300, total)).toBe(Math.floor(total / 2));
});

test('defaultGitDrawerLeftWidth uses the one-third ratio', () => {
  const total = 900;
  expect(defaultGitDrawerLeftWidth(total)).toBe(
    clampGitDrawerLeftWidth(total * GIT_DRAWER_DEFAULT_LEFT_RATIO, total),
  );
});
