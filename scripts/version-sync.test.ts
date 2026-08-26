import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Every file that carries the release version, and how to read it out.
 *
 * This exists because the desktop client's version is not cosmetic: the updater
 * compares the running bundle's version against the one in latest.json, so a
 * bundle left behind at an older number makes every install believe an update is
 * permanently available — the prompt reappears after each "successful" update.
 * scripts/release.sh bumps this exact list; a file that drifts out of it (a new
 * app, a hand-edited number) fails here rather than in a shipped release.
 */
const VERSION_SOURCES: Record<string, () => string> = {
  'package.json': () => json('package.json').version,
  'apps/server/package.json': () => json('apps/server/package.json').version,
  'apps/mobile/package.json': () => json('apps/mobile/package.json').version,
  'apps/mobile/app.json': () => json('apps/mobile/app.json').expo.version,
  'apps/mobile/src-tauri/tauri.conf.json': () =>
    json('apps/mobile/src-tauri/tauri.conf.json').version,
  'apps/mobile/src-tauri/Cargo.toml': () => cargoVersion('apps/mobile/src-tauri/Cargo.toml'),
  'apps/desktop/package.json': () => json('apps/desktop/package.json').version,
  'apps/desktop/src-tauri/tauri.conf.json': () =>
    json('apps/desktop/src-tauri/tauri.conf.json').version,
  'apps/desktop/src-tauri/Cargo.toml': () => cargoVersion('apps/desktop/src-tauri/Cargo.toml'),
};

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary manifest shapes
function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The `[package]` version — the first top-level `version =`, never a dependency's. */
function cargoVersion(path: string): string {
  const match = readFileSync(path, 'utf8').match(/^version = "([^"]*)"/m);
  if (!match) throw new Error(`no top-level version in ${path}`);
  return match[1];
}

describe('release versions', () => {
  const root = json('package.json').version as string;

  test('the root version is a plain semver number', () => {
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const [path, read] of Object.entries(VERSION_SOURCES)) {
    test(`${path} matches the root version`, () => {
      expect(read()).toBe(root);
    });
  }
});
