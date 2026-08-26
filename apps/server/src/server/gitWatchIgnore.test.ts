import { describe, expect, test } from 'bun:test';
import { shouldSkipWatchDirName } from './gitWatchIgnore';

describe('shouldSkipWatchDirName', () => {
  test('skips dependency and build trees that churn without affecting git status', () => {
    expect(shouldSkipWatchDirName('node_modules')).toBe(true);
    expect(shouldSkipWatchDirName('target')).toBe(true);
    expect(shouldSkipWatchDirName('dist')).toBe(true);
    expect(shouldSkipWatchDirName('.git')).toBe(true);
  });

  test('does not skip ordinary source directories', () => {
    expect(shouldSkipWatchDirName('src')).toBe(false);
    expect(shouldSkipWatchDirName('apps')).toBe(false);
    expect(shouldSkipWatchDirName('data')).toBe(false);
  });
});
