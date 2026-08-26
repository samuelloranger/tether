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

const IOS_PROJECT = 'clients/apple/Tether.xcodeproj/project.pbxproj';

/** Every MARKETING_VERSION in the Xcode project, which must all be the one value. */
function marketingVersion(path: string): string {
  const found = new Set(
    [...readFileSync(path, 'utf8').matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) =>
      m[1].trim(),
    ),
  );
  if (found.size === 0) throw new Error(`no MARKETING_VERSION in ${path}`);
  if (found.size > 1) throw new Error(`${path} has mixed versions: ${[...found].join(', ')}`);
  return [...found][0];
}

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

  /**
   * The native iOS client is allowed to run AHEAD of the repo version, and only
   * ahead.
   *
   * It shares one App Store Connect record with the Expo client it replaces, and
   * its line was deliberately started above that client's 2.8.x so the two never
   * interleave there. release.sh bumps this file with the others, so they
   * converge on the next release — but a value BEHIND the repo is the dangerous
   * direction: it is the number TestFlight displays for a hand-built upload, and
   * a duplicate (version, build) pair is rejected permanently.
   */
  test(`${IOS_PROJECT} is not behind the root version`, () => {
    const ios = marketingVersion(IOS_PROJECT);
    expect(ios).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compareSemver(ios, root)).toBeGreaterThanOrEqual(0);
  });
});

/** -1, 0 or 1. Both sides are asserted to be plain X.Y.Z before this is used. */
function compareSemver(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
