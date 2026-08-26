import { describe, expect, it } from 'bun:test';
import { splitPath } from './filePath';

describe('splitPath', () => {
  it('keeps the file name separate from its directory', () => {
    expect(splitPath('apps/desktop/src/App.tsx')).toEqual({
      dir: 'apps/desktop/src/',
      base: 'App.tsx',
    });
  });

  it('reports no directory for a file at the repo root', () => {
    expect(splitPath('bun.lock')).toEqual({ dir: '', base: 'bun.lock' });
  });

  it('does not lose a dotfile name', () => {
    expect(splitPath('.github/workflows/beta.yml')).toEqual({
      dir: '.github/workflows/',
      base: 'beta.yml',
    });
  });

  /// A trailing slash has no name to show; the caller still gets something
  /// renderable rather than an empty label.
  it('survives a trailing slash', () => {
    expect(splitPath('apps/desktop/')).toEqual({ dir: 'apps/desktop/', base: '' });
  });
});
