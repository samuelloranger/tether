import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getLiveCwd, recordChunk } from './liveCwd';
import {
  killSession,
  type Subscriber,
  sockPathFor,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';

async function waitFor(condition: () => boolean, timeout = 3_000) {
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

test('pushes git summaries to every subscriber and primes later subscribers', async () => {
  const id = 'git-summary-frames';
  const root = mkdtempSync(path.join(tmpdir(), 'tether-pty-git-'));
  const frames: Parameters<Subscriber>[0][] = [];
  let unsubscribe = () => {};
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });

    await startSession(id, 'bash');
    unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);
    writeToSession(id, `cd -- ${JSON.stringify(root)}\n`);
    await waitFor(() => getLiveCwd(id) === root);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    const changed = {
      files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: false }],
    };
    await waitFor(() =>
      frames.some((frame) => frame.type === 'diff' && frame.summary.files.length === 1),
    );
    expect(frames).toContainEqual({ type: 'diff', summary: changed });

    const later: Parameters<Subscriber>[0][] = [];
    const unsubscribeLater = subscribeToSession(id, (frame) => later.push(frame), 80, 24);
    expect(later).toEqual([{ type: 'diff', summary: changed }]);
    unsubscribeLater();
  } finally {
    unsubscribe();
    killSession(id);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh connection to an existing holder immediately learns the shell's current cwd", async () => {
  const id = 'holder-cwd-on-reattach';
  const root = mkdtempSync(path.join(tmpdir(), 'tether-pty-reattach-'));
  let raw: import('bun').Socket | null = null;
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });

    await startSession(id, 'bash');
    writeToSession(id, `cd -- ${JSON.stringify(root)}\n`);
    await waitFor(() => getLiveCwd(id) === root);

    // A brand new raw connection to the same holder socket — exactly what a
    // restarted server process does on reattach, bypassing pty.ts's own
    // instances Map (which already holds this session live in this test).
    const frames: Array<{ t: string; d?: string }> = [];
    let lineBuf = '';
    raw = await new Promise<import('bun').Socket>((resolve, reject) => {
      Bun.connect({
        unix: sockPathFor(id),
        socket: {
          open: (sock) => resolve(sock),
          data: (_sock, buf) => {
            lineBuf += buf.toString('utf8');
            let nl = lineBuf.indexOf('\n');
            while (nl !== -1) {
              const line = lineBuf.slice(0, nl);
              lineBuf = lineBuf.slice(nl + 1);
              nl = lineBuf.indexOf('\n');
              if (line) frames.push(JSON.parse(line));
            }
          },
          error: reject,
          close: () => {},
        },
      });
    });

    await waitFor(() => frames.some((f) => f.t === 'c'));
    expect(frames.find((f) => f.t === 'c')?.d).toBe(root);
  } finally {
    raw?.end();
    killSession(id);
    rmSync(root, { recursive: true, force: true });
  }
});

test('starts watching when a repository is initialized without changing cwd', async () => {
  const id = 'git-init-in-place';
  const root = mkdtempSync(path.join(tmpdir(), 'tether-pty-git-init-'));
  const frames: Parameters<Subscriber>[0][] = [];
  let unsubscribe = () => {};
  try {
    await startSession(id, 'bash');
    unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);
    writeToSession(id, `cd -- ${JSON.stringify(root)}\n`);
    await waitFor(() => getLiveCwd(id) === root);
    frames.length = 0;

    writeToSession(
      id,
      'git init -q && git config user.email test@example.com && git config user.name test && printf "one\\n" > main.txt && git add main.txt && git commit -q -m initial\n',
    );
    await waitFor(() => frames.some((frame) => frame.type === 'diff'));
    frames.length = 0;

    writeFileSync(path.join(root, 'main.txt'), 'two\n');
    await waitFor(() =>
      frames.some((frame) => frame.type === 'diff' && frame.summary.files.length === 1),
    );
    expect(frames).toContainEqual({
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
});
