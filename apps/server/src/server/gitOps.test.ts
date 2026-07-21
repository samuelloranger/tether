import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDiffSummary } from './gitDiff';
import {
  commitStaged,
  discardPath,
  GitOpsError,
  readCommitDiff,
  readLog,
  stageHunk,
  stagePath,
  unstageHunk,
  unstagePath,
} from './gitOps';

let root: string;

function git(cmd: string) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' });
}

function statusPorcelain(): string {
  return git('status --porcelain');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tether-gitops-'));
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name test');
  writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  git('add a.txt');
  git('commit -q -m initial');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stage/unstage file', () => {
  test('stagePath stages a modified file', () => {
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    stagePath(root, 'a.txt');
    expect(statusPorcelain()).toContain('M  a.txt');
  });

  test('stagePath stages an untracked file', () => {
    writeFileSync(path.join(root, 'new.txt'), 'hello\n');
    stagePath(root, 'new.txt');
    expect(statusPorcelain()).toContain('A  new.txt');
  });

  test('unstagePath moves a staged change back to unstaged', () => {
    writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    stagePath(root, 'a.txt');
    unstagePath(root, 'a.txt');
    expect(statusPorcelain()).toContain(' M a.txt');
  });

  test('path traversal rejected', () => {
    expect(() => stagePath(root, '../outside.txt')).toThrow(GitOpsError);
    expect(() => stagePath(root, '/etc/passwd')).toThrow(GitOpsError);
  });
});

describe('hunk staging', () => {
  // Two well-separated edits in one file → two hunks.
  function makeTwoHunks() {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(root, 'b.txt'), `${lines.join('\n')}\n`);
    git('add b.txt');
    git('commit -q -m add-b');
    lines[0] = 'EDIT top';
    lines[29] = 'EDIT bottom';
    writeFileSync(path.join(root, 'b.txt'), `${lines.join('\n')}\n`);
  }

  test('stageHunk stages only the requested hunk', () => {
    makeTwoHunks();
    stageHunk(root, 'b.txt', 0);
    const staged = git('diff --cached -- b.txt');
    const unstaged = git('diff -- b.txt');
    expect(staged).toContain('EDIT top');
    expect(staged).not.toContain('EDIT bottom');
    expect(unstaged).toContain('EDIT bottom');
  });

  test('unstageHunk reverses a staged hunk', () => {
    makeTwoHunks();
    stagePath(root, 'b.txt');
    unstageHunk(root, 'b.txt', 0);
    const staged = git('diff --cached -- b.txt');
    expect(staged).not.toContain('EDIT top');
    expect(staged).toContain('EDIT bottom');
  });

  test('out-of-range hunk index → 409 stale', () => {
    makeTwoHunks();
    expect(() => stageHunk(root, 'b.txt', 5)).toThrow(GitOpsError);
    try {
      stageHunk(root, 'b.txt', 5);
    } catch (e) {
      expect((e as GitOpsError).status).toBe(409);
    }
  });
});

describe('discardPath', () => {
  test('restores a tracked file', () => {
    writeFileSync(path.join(root, 'a.txt'), 'clobbered\n');
    discardPath(root, 'a.txt');
    expect(statusPorcelain()).toBe('');
  });

  test('deletes an untracked file', () => {
    const p = path.join(root, 'junk.txt');
    writeFileSync(p, 'junk\n');
    discardPath(root, 'junk.txt');
    expect(existsSync(p)).toBe(false);
  });

  test('path traversal rejected before touching disk', () => {
    expect(() => discardPath(root, '../../etc/passwd')).toThrow(GitOpsError);
  });
});

describe('commitStaged', () => {
  test('commits staged changes with the given message', () => {
    writeFileSync(path.join(root, 'a.txt'), 'committed content\n');
    stagePath(root, 'a.txt');
    commitStaged(root, 'my "quoted" message\n\nwith a body');
    expect(git('log -1 --format=%s')).toBe('my "quoted" message\n');
    expect(git('log -1 --format=%b')).toContain('with a body');
    expect(statusPorcelain()).toBe('');
  });

  test('nothing staged → 409 with git message', () => {
    try {
      commitStaged(root, 'empty');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitOpsError);
      expect((e as GitOpsError).status).toBe(409);
    }
  });
});

describe('readLog / readCommitDiff', () => {
  test('readLog returns commits newest first', () => {
    writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    git('add a.txt');
    git('commit -q -m second');
    const log = readLog(root, 10);
    expect(log.length).toBe(2);
    expect(log[0].subject).toBe('second');
    expect(log[1].subject).toBe('initial');
    expect(log[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log[0].shortSha.length).toBeGreaterThanOrEqual(7);
    expect(log[0].author).toBe('test');
  });

  test('readCommitDiff returns the diff of one commit', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    git('add a.txt');
    git('commit -q -m second');
    const sha = git('rev-parse HEAD').trim();
    const { diff } = await readCommitDiff(root, sha);
    expect(diff).toContain('+v2');
    expect(diff).toContain('a.txt');
  });

  test('root commit diff works (no parent)', async () => {
    const sha = git('rev-parse HEAD').trim();
    const { diff } = await readCommitDiff(root, sha);
    expect(diff).toContain('+one');
  });

  test('invalid sha rejected', async () => {
    expect(readCommitDiff(root, 'not-a-sha!')).rejects.toThrow(GitOpsError);
  });

  test('commit diff scoped to one file', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    writeFileSync(path.join(root, 'c.txt'), 'c\n');
    git('add .');
    git('commit -q -m both');
    const sha = git('rev-parse HEAD').trim();
    const { diff } = await readCommitDiff(root, sha, 'c.txt');
    expect(diff).toContain('+c');
    expect(diff).not.toContain('+v2');
  });
});

describe('readDiffSummary staged split', () => {
  test('marks staged and unstaged entries; partially staged file appears twice', () => {
    // staged-only change
    writeFileSync(path.join(root, 'staged.txt'), 's\n');
    git('add staged.txt');
    // unstaged-only change (untracked)
    writeFileSync(path.join(root, 'unstaged.txt'), 'u\n');
    // partially staged: stage one edit, then edit again
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nstaged-edit\n');
    git('add a.txt');
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nstaged-edit\nunstaged-edit\n');

    const summary = readDiffSummary(root);
    const key = (f: { path: string; staged?: boolean }) => `${f.path}:${f.staged}`;
    const keys = new Set(summary.files.map(key));
    expect(keys.has('staged.txt:true')).toBe(true);
    expect(keys.has('unstaged.txt:false')).toBe(true);
    expect(keys.has('a.txt:true')).toBe(true);
    expect(keys.has('a.txt:false')).toBe(true);
  });
});

describe('readDiff modes', () => {
  test('staged mode shows index-vs-HEAD, unstaged mode shows worktree-vs-index', async () => {
    const { readDiff } = await import('./gitDiff');
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nstaged-edit\n');
    git('add a.txt');
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nstaged-edit\nunstaged-edit\n');

    const staged = await readDiff(root, 'a.txt', 'staged');
    expect(staged.diff).toContain('+staged-edit');
    expect(staged.diff).not.toContain('unstaged-edit');

    const unstaged = await readDiff(root, 'a.txt', 'unstaged');
    expect(unstaged.diff).toContain('+unstaged-edit');
    expect(unstaged.diff).not.toContain('+staged-edit');
  });

  test('unstaged mode still surfaces untracked files', async () => {
    const { readDiff } = await import('./gitDiff');
    writeFileSync(path.join(root, 'fresh.txt'), 'hello\n');
    const out = await readDiff(root, 'fresh.txt', 'unstaged');
    expect(out.diff).toContain('+hello');
  });
});
