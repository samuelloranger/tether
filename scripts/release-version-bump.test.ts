import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// release.sh moves the desktop workspace version with the app's: runs its real
// bump_desktop_version on a copy of clients/desktop's manifests and lock file.
const SCRIPT = readFileSync('scripts/release.sh', 'utf8');
const DESKTOP = 'clients/desktop';

function bumpFn(): string {
  const start = SCRIPT.indexOf('bump_desktop_version() {');
  const end = start < 0 ? -1 : SCRIPT.indexOf('\n}\n', start) + 3;
  if (start < 0 || end <= start) {
    throw new Error('release.sh no longer has bump_desktop_version where this test expects it');
  }
  return SCRIPT.slice(start, end);
}

function copyManifests(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-bump-'));
  cpSync(path.join(DESKTOP, 'Cargo.toml'), path.join(dir, 'Cargo.toml'));
  cpSync(path.join(DESKTOP, 'Cargo.lock'), path.join(dir, 'Cargo.lock'));
  for (const crate of readdirSync(path.join(DESKTOP, 'crates'))) {
    mkdirSync(path.join(dir, 'crates', crate), { recursive: true });
    cpSync(path.join(DESKTOP, 'crates', crate, 'Cargo.toml'), path.join(dir, 'crates', crate, 'Cargo.toml'));
  }
  return dir;
}

/** Version recorded in a lock file for one package. */
function lockVersion(lock: string, name: string): string | undefined {
  return lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1];
}

test('the workspace version and every lock entry that inherits it move together', () => {
  const dir = copyManifests();
  const before = readFileSync(path.join(dir, 'Cargo.lock'), 'utf8');
  const p = Bun.spawnSync(['bash', '-c', `set -euo pipefail\n${bumpFn()}\nbump_desktop_version "${dir}" 9.8.7`]);
  expect(p.stderr.toString()).toBe('');
  expect(p.exitCode).toBe(0);

  const toml = readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
  expect(toml).toMatch(/\[workspace\.package\]\nversion = "9\.8\.7"/);

  const lock = readFileSync(path.join(dir, 'Cargo.lock'), 'utf8');
  const inheriting = readdirSync(path.join(DESKTOP, 'crates'))
    .map((c) => readFileSync(path.join(DESKTOP, 'crates', c, 'Cargo.toml'), 'utf8'))
    .filter((m) => /^version\.workspace = true/m.test(m))
    .map((m) => m.match(/^name = "(.+)"$/m)?.[1] as string);
  expect(inheriting).toContain('tether-app');
  for (const name of inheriting) expect(lockVersion(lock, name)).toBe('9.8.7');

  // Nothing else in the lock moves: crates with their own version and every dependency.
  const changed = before.split('\n').filter((line, i) => line !== lock.split('\n')[i]);
  expect(changed.length).toBe(inheriting.length);
  expect(lock.split('\n').length).toBe(before.split('\n').length);
});

test('release.sh commits the desktop manifests with the version bump', () => {
  const files = SCRIPT.slice(SCRIPT.indexOf('VERSION_FILES=('), SCRIPT.indexOf(')', SCRIPT.indexOf('VERSION_FILES=(')));
  expect(files).toContain('clients/desktop/Cargo.toml');
  expect(files).toContain('clients/desktop/Cargo.lock');
});
