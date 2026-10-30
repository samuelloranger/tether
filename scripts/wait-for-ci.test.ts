import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs .github/scripts/wait-for-ci.sh against a fake `gh` that answers `run list` with one
// line per call from a script, so waiting, success, failure and the timeout are checked.
const SCRIPT = path.resolve('.github/scripts/wait-for-ci.sh');

function run(answers: string[], env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-wait-ci-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(root, 'answers'), `${answers.join('\n')}\n`);
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1 $2" = "run list" ] || exit 2
echo "$*" >> "${root}/args"
n=$(cat "${root}/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "${root}/count"
line=$(sed -n "$((n + 1))p" "${root}/answers")
[ "$line" = "-" ] || echo "$line"
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const proc = Bun.spawnSync(['bash', SCRIPT, 'abc1234def'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WAIT_INTERVAL: '0', ...env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString(), root };
}

test('waits for the run to appear and finish, then passes', () => {
  const r = run(['-', 'queued  u', 'in_progress  u', 'completed success https://ci/1']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('CI passed for abc1234');
  expect(r.out).toContain('CI for abc1234: none');
  expect(r.out).toContain('CI for abc1234: in_progress');
  const args = Bun.file(path.join(r.root, 'args'));
  return args.text().then((text) => {
    expect(text).toContain('--workflow ci.yml --commit abc1234def --event push');
  });
});

test('a failed or cancelled CI run stops the upload', () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const r = run([`completed ${conclusion} https://ci/2`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`ended with '${conclusion}'`);
  }
});

test('gives up after the timeout instead of hanging', () => {
  const r = run(['in_progress  u', 'in_progress  u', 'in_progress  u'], { WAIT_TIMEOUT: '0' });
  expect(r.code).toBe(1);
  expect(r.out).toContain('Gave up waiting for CI on abc1234');
});
