import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs .github/scripts/update-feed.sh against a fake `gh` whose "release" is a directory, so
// the upload order, the never-backwards rule and the pruning are checked on real files.
const SCRIPT = path.resolve('.github/scripts/update-feed.sh');

function fakeGh(root: string): string {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
# gh release <verb> <feed> ...: the feed is ${root}/releases/<feed>.
set -euo pipefail
[ "$1" = release ] || exit 2
verb=$2 feed=$3; shift 3
dir="${root}/releases/$feed"
log="${root}/log"
case "$verb" in
  view)
    [ -d "$dir" ] || exit 1
    if [ "\${1:-}" = --json ]; then ls -1 "$dir"; fi ;;
  create) mkdir -p "$dir"; echo "create $feed" >> "$log" ;;
  download)
    pattern="" out=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) pattern=$2; shift ;; -O) out=$2; shift ;; esac
      shift
    done
    [ -f "$dir/$pattern" ] || exit 1
    cp "$dir/$pattern" "$out" ;;
  upload) cp "$1" "$dir/"; echo "upload $(basename "$1")" >> "$log" ;;
  delete-asset) rm "$dir/$1"; echo "delete $1" >> "$log" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

function json(versions: [string, string][]): string {
  return JSON.stringify({ Assets: versions.map(([v, f]) => ({ Version: v, FileName: f, Type: 'Full' })) });
}

/** A feed release with these files already on it. */
function seedFeed(root: string, feed: string, files: Record<string, string>) {
  const dir = path.join(root, 'releases', feed);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
}

/** vpk output for one version. */
function packed(root: string, channel: string, version: string, nupkg: string): string {
  const dir = mkdtempSync(path.join(root, 'pack-'));
  writeFileSync(path.join(dir, nupkg), version);
  writeFileSync(path.join(dir, `releases.${channel}.json`), json([[version, nupkg]]));
  return dir;
}

function run(root: string, args: string[]) {
  const proc = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: { ...process.env, PATH: `${fakeGh(root)}:${process.env.PATH}` },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
    feed: (feed: string) => readdirSync(path.join(root, 'releases', feed)).sort(),
    log: existsSync(path.join(root, 'log')) ? readFileSync(path.join(root, 'log'), 'utf8').trim().split('\n') : [],
  };
}

const tmp = () => mkdtempSync(path.join(tmpdir(), 'tether-feed-'));

test('a stable release moves its own json, keeps the previous package and leaves edge alone', () => {
  const root = tmp();
  seedFeed(root, 'linux-feed', {
    'tether-5.9.0-linux-full.nupkg': '',
    'tether-6.0.0-linux-full.nupkg': '',
    'releases.linux.json': json([['6.0.0', 'tether-6.0.0-linux-full.nupkg']]),
    'tether-6.0.1-main.40-linux-edge-full.nupkg': '',
    'releases.linux-edge.json': json([['6.0.1-main.40', 'tether-6.0.1-main.40-linux-edge-full.nupkg']]),
  });
  const dir = packed(root, 'linux', '6.1.0', 'tether-6.1.0-linux-full.nupkg');
  const r = run(root, ['linux-feed', 'linux', 'stable', '6.1.0', dir]);
  expect(r.code).toBe(0);
  expect(r.feed('linux-feed')).toEqual([
    'releases.linux-edge.json',
    'releases.linux.json',
    'tether-6.0.0-linux-full.nupkg',
    'tether-6.0.1-main.40-linux-edge-full.nupkg',
    'tether-6.1.0-linux-full.nupkg',
  ]);
  const uploads = r.log.filter((l) => l.startsWith('upload'));
  expect(uploads.at(-1)).toBe('upload releases.linux.json');
});

test('an edge build goes on its own channel json', () => {
  const root = tmp();
  seedFeed(root, 'windows-feed', {
    'TetherTerminal-6.0.0-full.nupkg': '',
    'releases.win.json': json([['6.0.0', 'TetherTerminal-6.0.0-full.nupkg']]),
  });
  const dir = packed(root, 'win-edge', '6.0.1-main.41', 'TetherTerminal-6.0.1-main.41-win-edge-full.nupkg');
  const setup = path.join(dir, 'Tether-6.0.1-main.41-x64-Setup.exe');
  writeFileSync(setup, 'exe');
  const r = run(root, ['windows-feed', 'win', 'edge', '6.0.1-main.41', dir, setup, 'Tether-edge-x64-Setup.exe']);
  expect(r.code).toBe(0);
  expect(r.feed('windows-feed')).toEqual([
    'Tether-edge-x64-Setup.exe',
    'TetherTerminal-6.0.0-full.nupkg',
    'TetherTerminal-6.0.1-main.41-win-edge-full.nupkg',
    'releases.win-edge.json',
    'releases.win.json',
  ]);
});

test('a run that finishes late never moves the feed backwards', () => {
  const root = tmp();
  seedFeed(root, 'linux-feed', {
    'tether-6.1.1-main.52-linux-edge-full.nupkg': '',
    'releases.linux-edge.json': json([['6.1.1-main.52', 'tether-6.1.1-main.52-linux-edge-full.nupkg']]),
  });
  const dir = packed(root, 'linux-edge', '6.0.1-main.50', 'tether-6.0.1-main.50-linux-edge-full.nupkg');
  const r = run(root, ['linux-feed', 'linux', 'edge', '6.0.1-main.50', dir]);
  expect(r.code).toBe(0);
  expect(r.out).toContain('leaving it');
  expect(r.log.filter((l) => l.startsWith('upload'))).toEqual([]);
});

test('the package before the previous one is pruned', () => {
  const root = tmp();
  seedFeed(root, 'linux-feed', {
    'tether-6.0.1-main.40-linux-edge-full.nupkg': '',
    'tether-6.0.1-main.41-linux-edge-full.nupkg': '',
    'releases.linux-edge.json': json([['6.0.1-main.41', 'tether-6.0.1-main.41-linux-edge-full.nupkg']]),
  });
  const dir = packed(root, 'linux-edge', '6.0.1-main.42', 'tether-6.0.1-main.42-linux-edge-full.nupkg');
  const r = run(root, ['linux-feed', 'linux', 'edge', '6.0.1-main.42', dir]);
  expect(r.code).toBe(0);
  expect(r.feed('linux-feed')).toEqual([
    'releases.linux-edge.json',
    'tether-6.0.1-main.41-linux-edge-full.nupkg',
    'tether-6.0.1-main.42-linux-edge-full.nupkg',
  ]);
});

test('a missing feed release is created first', () => {
  const root = tmp();
  const dir = packed(root, 'linux', '6.0.0', 'tether-6.0.0-linux-full.nupkg');
  const r = run(root, ['linux-feed', 'linux', 'stable', '6.0.0', dir]);
  expect(r.code).toBe(0);
  expect(r.log[0]).toBe('create linux-feed');
  expect(r.feed('linux-feed')).toEqual(['releases.linux.json', 'tether-6.0.0-linux-full.nupkg']);
});

test('is_newer orders stable by version and edge by run number', () => {
  const cases: [string, string, string, boolean][] = [
    ['stable', '6.1.0', '6.0.0', true],
    ['stable', '6.0.10', '6.0.9', true],
    ['stable', '6.0.0', '6.0.0', false],
    ['stable', '5.11.0', '6.0.0', false],
    ['edge', '6.0.1-main.100', '6.0.1-main.99', true],
    ['edge', '6.1.1-main.120', '6.0.1-main.99', true],
    ['edge', '6.0.1-main.99', '6.0.1-main.100', false],
  ];
  for (const [channel, a, b, want] of cases) {
    const p = Bun.spawnSync(['bash', '-c', `source "${SCRIPT}"; is_newer ${channel} ${a} ${b}`]);
    expect([channel, a, b, p.exitCode === 0]).toEqual([channel, a, b, want]);
  }
});
