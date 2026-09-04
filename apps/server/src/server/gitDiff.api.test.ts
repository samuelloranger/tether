import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalFixture, osc7Chunk } from '../../test-paths';
import { app } from './app';
import { upsertSession } from './db';
import { clearLiveCwd, recordChunk } from './liveCwd';
import { testAuthHeaders } from './testAuth';

/**
 * Runs git without blocking the event loop.
 *
 * The fixture below used execSync, which pins the JS thread for the whole call
 * — so bun's per-test timeout can never fire while git is running, and the
 * route handlers under test (which spawn git of their own) cannot make progress
 * either. Same reasoning, and the same shape, as gitWatch.test.ts's helper.
 */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
}

/**
 * Six git spawns build the fixture and three more answer the routes, and on
 * Windows CreateProcess plus the antimalware scan of git.exe costs ~30ms per
 * call idle and 200-380ms once several `bun test --parallel` workers overlap
 * (Linux pays ~5ms). This test measured 4.6s under that load against bun's 5s
 * default and died as an opaque timeout. 20s is a backstop; the same test
 * finishes in under a second on an idle machine.
 */
const GIT_TEST_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000;

test(
  'diff routes summarize and return an in-progress change',
  async () => {
    const AUTH = testAuthHeaders();
    const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-diff-api-')));
    try {
      await git(root, 'init', '-q');
      await git(root, 'config', 'user.email', 'test@example.com');
      await git(root, 'config', 'user.name', 'test');
      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
      await git(root, 'add', 'main.ts');
      await git(root, 'commit', '-q', '-m', 'initial');
      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');

      upsertSession('diff-session', 'bash', 'running');
      recordChunk('diff-session', osc7Chunk(root));

      const summary = await app.request('/api/sessions/diff-session/diff/summary', {
        headers: AUTH,
      });
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual({
        files: [
          {
            path: 'main.ts',
            insertions: 1,
            deletions: 1,
            binary: false,
            staged: false,
            untracked: false,
          },
        ],
      });

      const diff = await app.request(
        `/api/sessions/diff-session/diff?path=${encodeURIComponent('main.ts')}`,
        {
          headers: AUTH,
        },
      );
      expect(diff.status).toBe(200);
      const body = (await diff.json()) as { diff: string; truncated: boolean };
      expect(body.truncated).toBe(false);
      expect(body.diff).toContain('+export const answer = 43;');

      upsertSession('diff-pending', 'bash', 'running');
      const pending = await app.request('/api/sessions/diff-pending/diff/summary', {
        headers: AUTH,
      });
      expect(pending.status).toBe(409);
    } finally {
      clearLiveCwd('diff-session');
      clearLiveCwd('diff-pending');
      rmSync(root, { recursive: true, force: true });
    }
  },
  GIT_TEST_TIMEOUT_MS,
);
