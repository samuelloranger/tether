import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalFixture } from '../../test-paths';
import { cdLine, PTY_TEST_TIMEOUT_MS, SHELL_TIMEOUT_MS, TEST_SHELL } from '../../test-shell';
import { decodeHolderFrame, HOLDER_PROTO_VERSION, type HolderMessage } from './holderFrame';
import { clearLiveCwd, getLiveCwd, recordChunk } from './liveCwd';
import { FrameDecoder } from './proto/frame';
import {
  killSession,
  type Subscriber,
  sockPathFor,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { refreshLiveCwd } from './ptyHolder';

async function waitFor(condition: () => boolean, timeout = SHELL_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  expect(condition()).toBe(true);
}

test('killing a session clears its live cwd without waiting for a PTY exit frame', () => {
  const id = 'kill-clears-live-cwd';
  recordChunk(id, '\x1b]7;file://host/tmp/old-workspace\x07');

  killSession(id);

  expect(getLiveCwd(id)).toBeNull();
});

test(
  'pushes git summaries to every subscriber and primes later subscribers',
  async () => {
    const id = 'git-summary-frames';
    const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-pty-git-')));
    const frames: Parameters<Subscriber>[0][] = [];
    let unsubscribe = () => {};
    try {
      execSync('git init -q', { cwd: root });
      execSync('git config user.email test@example.com', { cwd: root });
      execSync('git config user.name test', { cwd: root });
      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
      execSync('git add main.ts && git commit -q -m initial', { cwd: root });

      await startSession(id, TEST_SHELL);
      unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);
      writeToSession(id, cdLine(root));
      await waitFor(() => getLiveCwd(id) === root);

      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
      const changed = {
        files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: false }],
      };
      await waitFor(() =>
        frames.some((frame) => frame.type === 'diff' && frame.summary.files.length === 1),
      );
      const changedFrame = frames.find(
        (frame) => frame.type === 'diff' && frame.summary.files.length === 1,
      );
      expect(changedFrame).toMatchObject({ type: 'diff', summary: changed });
      expect(
        changedFrame && changedFrame.type === 'diff' && changedFrame.status?.branch,
      ).toBeTruthy();

      const later: Parameters<Subscriber>[0][] = [];
      const unsubscribeLater = subscribeToSession(id, (frame) => later.push(frame), 80, 24);
      expect(later).toHaveLength(1);
      expect(later[0]).toMatchObject({ type: 'diff', summary: changed });
      unsubscribeLater();
    } finally {
      unsubscribe();
      killSession(id);
      rmSync(root, { recursive: true, force: true });
    }
  },
  PTY_TEST_TIMEOUT_MS,
);

test(
  "a fresh connection to an existing holder immediately learns the shell's current cwd",
  async () => {
    const id = 'holder-cwd-on-reattach';
    const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-pty-reattach-')));
    let raw: import('bun').Socket | null = null;
    try {
      execSync('git init -q', { cwd: root });
      execSync('git config user.email test@example.com', { cwd: root });
      execSync('git config user.name test', { cwd: root });
      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
      execSync('git add main.ts && git commit -q -m initial', { cwd: root });

      await startSession(id, TEST_SHELL);
      writeToSession(id, cdLine(root));
      await waitFor(() => getLiveCwd(id) === root);

      // A brand new raw connection to the same holder socket — exactly what a
      // restarted server process does on reattach, bypassing pty.ts's own
      // instances Map (which already holds this session live in this test).
      const frames: HolderMessage[] = [];
      const decoder = new FrameDecoder();
      raw = await new Promise<import('bun').Socket>((resolve, reject) => {
        Bun.connect({
          unix: sockPathFor(id),
          socket: {
            open: (sock) => resolve(sock),
            data: (_sock, buf) => {
              for (const frame of decoder.push(new Uint8Array(buf))) {
                const msg = decodeHolderFrame(frame);
                if (msg) frames.push(msg);
              }
            },
            error: reject,
            close: () => {},
          },
        });
      });

      // HELLO first, so a reattaching server knows the dialect before it writes.
      await waitFor(() => frames.some((f) => f.type === 'hello'));
      expect(frames[0]).toEqual({ type: 'hello', version: HOLDER_PROTO_VERSION });
      await waitFor(() => frames.some((f) => f.type === 'cwd'));
      const cwdFrame = frames.find((f) => f.type === 'cwd');
      expect(cwdFrame?.type === 'cwd' && cwdFrame.cwd).toBe(root);
    } finally {
      raw?.end();
      killSession(id);
      rmSync(root, { recursive: true, force: true });
    }
  },
  PTY_TEST_TIMEOUT_MS,
);

test(
  'starts watching when a repository is initialized without changing cwd',
  async () => {
    const id = 'git-init-in-place';
    const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-pty-git-init-')));
    const frames: Parameters<Subscriber>[0][] = [];
    let unsubscribe = () => {};
    try {
      await startSession(id, TEST_SHELL);
      unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);
      writeToSession(id, cdLine(root));
      await waitFor(() => getLiveCwd(id) === root);
      frames.length = 0;

      // The shell must be the one running `git init`, since the point is that a
      // repo appearing under an unchanged cwd still arms the watch. Only the file
      // write moves out to Node — `printf ... >` is POSIX-only, and `&&` is the
      // one chaining operator bash, cmd and PowerShell 7 all agree on.
      writeFileSync(path.join(root, 'main.txt'), 'one\n');
      writeToSession(
        id,
        'git init -q && git config user.email test@example.com && git config user.name test && git add main.txt && git commit -q -m initial' +
          (process.platform === 'win32' ? '\r' : '\n'),
      );
      await waitFor(() => frames.some((frame) => frame.type === 'diff'));
      frames.length = 0;

      writeFileSync(path.join(root, 'main.txt'), 'two\n');
      await waitFor(() =>
        frames.some((frame) => frame.type === 'diff' && frame.summary.files.length === 1),
      );
      expect(
        frames.find((frame) => frame.type === 'diff' && frame.summary.files.length === 1),
      ).toMatchObject({
        type: 'diff',
        summary: {
          files: [{ path: 'main.txt', insertions: 1, deletions: 1, binary: false, staged: false }],
        },
      });
    } finally {
      unsubscribe();
      killSession(id);
      rmSync(root, { recursive: true, force: true });
    }
  },
  PTY_TEST_TIMEOUT_MS,
);

test(
  'refreshLiveCwd re-reads the shell cwd with no OSC 7 prompt involved',
  async () => {
    // The gap this closes: a shell whose prompt does not emit OSC 7 left the live
    // cwd stuck wherever the session started, so the git and file routes answered
    // about the wrong directory. Clearing the recorded value simulates exactly
    // that shell — the process really is in `root`, and nothing has reported it.
    const id = 'refresh-live-cwd';
    const root = canonicalFixture(
      realpathSync(mkdtempSync(path.join(tmpdir(), 'tether-refresh-cwd-'))),
    );
    let unsubscribe = () => {};
    try {
      await startSession(id, TEST_SHELL);
      unsubscribe = subscribeToSession(id, () => {}, 80, 24);
      writeToSession(id, cdLine(root));
      await waitFor(() => getLiveCwd(id) === root);

      clearLiveCwd(id);
      expect(getLiveCwd(id)).toBeNull();

      expect(await refreshLiveCwd(id)).toBe(true);
      expect(getLiveCwd(id)).toBe(root);
    } finally {
      unsubscribe();
      killSession(id);
      rmSync(root, { recursive: true, force: true });
    }
  },
  PTY_TEST_TIMEOUT_MS,
);

test('refreshLiveCwd reports failure instead of throwing when there is no holder', async () => {
  expect(await refreshLiveCwd('no-such-session-for-cwd-refresh')).toBe(false);
});
