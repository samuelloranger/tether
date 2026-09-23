import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The gate that stops a release publishing over a red CI run: runs release.sh's real CI helpers
// against a fake `gh`, so the jq that reads an in-progress run's empty conclusion is exercised too.
const SCRIPT = readFileSync('scripts/release.sh', 'utf8');

/** The `ci_run_for` + `wait_for_ci` block, lifted verbatim. */
function helpers(): string {
  const start = SCRIPT.indexOf('CI_WAIT_SECONDS=');
  const waitFn = SCRIPT.indexOf('wait_for_ci() {');
  const end = waitFn < 0 ? -1 : SCRIPT.indexOf('\n}\n', waitFn) + 3;
  if (start < 0 || end <= start) {
    throw new Error('release.sh no longer has the CI wait helpers where this test expects them');
  }
  return SCRIPT.slice(start, end);
}

type Run = { status: string; conclusion: string; url: string };

/** One canned `gh run list` answer per call, in order. `null` = no run yet. */
function ghStub(dir: string, answers: (Run | null)[]): string {
  const bin = path.join(dir, 'bin');
  const responses = path.join(dir, 'responses');
  writeFileSync(responses, `${answers.map((a) => JSON.stringify(a ? [a] : [])).join('\n')}\n`);
  const gh = path.join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
# Applies the caller's own -q expression to the canned payload for this call, so
# the jq in release.sh is what gets tested rather than a paraphrase of it.
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "${dir}/count"
expr=""
prev=""
for a in "$@"; do
  [ "$prev" = "-q" ] && expr="$a"
  prev="$a"
done
body=$(sed -n "\${n}p" "${responses}")
[ -z "$body" ] && body='[]'
printf '%s' "$body" | jq -r "$expr"
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

async function waitForCi(
  answers: (Run | null)[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-ci-gate-'));
  Bun.spawnSync(['mkdir', '-p', path.join(dir, 'bin')]);
  const bin = ghStub(dir, answers);
  const proc = Bun.spawnSync(['bash', '-c', `set -euo pipefail\n${helpers()}\nwait_for_ci abc123`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CI_POLL_SECONDS: '0',
      CI_WAIT_SECONDS: '60',
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const inProgress: Run = { status: 'in_progress', conclusion: '', url: 'https://ci/1' };
const queued: Run = { status: 'queued', conclusion: '', url: 'https://ci/1' };
const green: Run = { status: 'completed', conclusion: 'success', url: 'https://ci/1' };
const red: Run = { status: 'completed', conclusion: 'failure', url: 'https://ci/1' };

test('waits through a run that has not been created yet, then passes on green', async () => {
  const { code, stdout } = await waitForCi([null, queued, inProgress, green]);
  expect(code).toBe(0);
  expect(stdout).toContain('CI is green on abc123: https://ci/1');
});

test('fails on a completed run that is not success, and names the conclusion', async () => {
  const { code, stderr } = await waitForCi([red]);
  expect(code).toBe(1);
  expect(stderr).toContain("CI concluded 'failure' on abc123: https://ci/1");
});

test('a cancelled run is a failure, not a pass', async () => {
  const { code, stderr } = await waitForCi([{ status: 'completed', conclusion: 'cancelled', url: 'https://ci/1' }]);
  expect(code).toBe(1);
  expect(stderr).toContain("'cancelled'");
});

// An in-progress run reports an EMPTY conclusion; treating it as a failure fails every release.
test('an in-progress run is neither a pass nor a failure', async () => {
  const { code, stdout } = await waitForCi([inProgress, inProgress, green]);
  expect(code).toBe(0);
  expect(stdout).toContain('CI is green');
});

test('reports each status once, not once per poll', async () => {
  const { stdout } = await waitForCi([inProgress, inProgress, inProgress, green]);
  expect(stdout.match(/CI is in_progress/g)?.length).toBe(1);
});

test('gives up when no run ever appears', async () => {
  const { code, stderr } = await waitForCi([null], { CI_WAIT_SECONDS: '0' });
  expect(code).toBe(1);
  expect(stderr).toContain('no run found');
});

// A branch that is neither main nor a PR never gets a CI run: fail fast instead of a 1 h timeout.
test('says so quickly when the branch produces no run at all', async () => {
  const { code, stderr } = await waitForCi([null, null], { CI_APPEAR_SECONDS: '0' });
  expect(code).toBe(1);
  expect(stderr).toContain('no CI run exists');
  expect(stderr).toContain('pull requests');
});

// The wait must sit between pushing the bump and pushing the tag: after the tag, release.yml is
// already building.
test('release.sh waits for the release commit between the branch push and the tag', () => {
  const push = SCRIPT.indexOf('git push origin "$BRANCH"');
  const wait = SCRIPT.indexOf('wait_for_ci "$RELEASE_SHA"');
  const tag = SCRIPT.indexOf('git tag -a "v$TARGET_VERSION"');
  expect(push).toBeGreaterThan(-1);
  expect(wait).toBeGreaterThan(push);
  expect(tag).toBeGreaterThan(wait);
});

test('the release commit is the one that gets graded, not HEAD before the bump', () => {
  expect(SCRIPT).toContain('RELEASE_SHA=$(git rev-parse HEAD)');
  const commit = SCRIPT.indexOf('git commit -m "release: v$TARGET_VERSION"');
  expect(SCRIPT.indexOf('RELEASE_SHA=$(git rev-parse HEAD)')).toBeGreaterThan(commit);
});
