# Git Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #38's frozen per-session `workspace_root` with a live cwd the server tracks authoritatively from the shell's own OSC 7 reports, and use it to power both the existing file viewer and a new read-only git diff view for reviewing edits an agent (or anyone) makes mid-session.

**Architecture:** The server parses OSC 7 (`\x1b]7;file://host/path\x07`) out of the same PTY byte stream it already logs/broadcasts, keeping an in-memory live cwd per session. On each `/file` or `/diff` request it resolves that cwd to its nearest git top-level (or the cwd itself if not a repo) fresh, never cached, and never accepting a client-supplied cwd. Mobile gets a new `DiffView` (changed-files list → per-file unified diff), opened on demand from the overflow menu, following the exact read-only/no-editor/no-refresh philosophy `FileViewer` already established.

**Tech Stack:** Bun, TypeScript, Hono, `node:child_process` (`git` CLI), Expo React Native/react-native-web.

## Global Constraints

- Never accept a client-supplied cwd for `/file` or `/diff` — the server's own OSC7-derived live cwd is the only source.
- Root is resolved fresh on every request via `git -C <liveCwd> rev-parse --show-toplevel` (falling back to `liveCwd` itself when not a repo) — no caching.
- Diff scope is `git diff HEAD` (working tree vs `HEAD`) only. No arbitrary ref/branch comparison.
- Read-only: no staging, committing, reverting, or discarding from the UI.
- No polling/auto-refresh — the diff view's data is fetched only when the user opens it (mirrors `FileViewer`'s "no refresh button" constraint).
- Returned diff text is capped at 1 MiB, with an explicit `truncated: true` flag rather than silent truncation.
- Reuse `workspaceFile.ts`'s existing path validation/containment (`realpathSync` + `inside()`, `..`/absolute rejection) for the `path` query param on `/file` and `/diff` — do not re-implement it.
- No global store, WebView, editor, syntax highlighter, or file browser — same restriction PR #38 already established.
- Run `cd apps/server && bun test` and `cd apps/mobile && bun test && npx tsc --noEmit && bun run lint` before merge.

---

### Task 1: Track each session's live cwd from its own PTY output

**Files:**
- Create: `apps/server/src/server/liveCwd.ts`
- Create: `apps/server/src/server/liveCwd.test.ts`
- Modify: `apps/server/src/server/pty.ts:14` (import), `apps/server/src/server/pty.ts:180-186` (`flushOutput`), `apps/server/src/server/pty.ts:198-211` (exit handling)

**Interfaces:**
- Produces: `updateLiveCwd(state: LiveCwdState, chunk: string): LiveCwdState`, `INITIAL_LIVE_CWD_STATE`, `recordChunk(sessionId: string, chunk: string): void`, `getLiveCwd(sessionId: string): string | null`, `clearLiveCwd(sessionId: string): void`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing parser tests**

Create `apps/server/src/server/liveCwd.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { INITIAL_LIVE_CWD_STATE, updateLiveCwd, recordChunk, getLiveCwd, clearLiveCwd } from './liveCwd';

test('parses a complete OSC 7 cwd report', () => {
  const chunk = '\x1b]7;file://myhost/home/sam/project\x07';
  const state = updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk);
  expect(state.cwd).toBe('/home/sam/project');
  expect(state.residual).toBe('');
});

test('decodes percent-escaped paths', () => {
  const chunk = '\x1b]7;file://myhost/home/sam/My%20Project\x07';
  expect(updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk).cwd).toBe('/home/sam/My Project');
});

test('keeps the previous cwd when a chunk has no OSC 7 report', () => {
  const first = updateLiveCwd(INITIAL_LIVE_CWD_STATE, '\x1b]7;file://h/a\x07');
  const second = updateLiveCwd(first, 'plain shell output, no escapes\n');
  expect(second.cwd).toBe('/a');
});

test('keeps the last report when a chunk has multiple cd reports', () => {
  const chunk = '\x1b]7;file://h/a\x07some output\x1b]7;file://h/b\x07';
  expect(updateLiveCwd(INITIAL_LIVE_CWD_STATE, chunk).cwd).toBe('/b');
});

test('reassembles an OSC 7 report split across two chunks', () => {
  const whole = '\x1b]7;file://h/home/sam/project\x07';
  const first = updateLiveCwd(INITIAL_LIVE_CWD_STATE, whole.slice(0, 15));
  expect(first.cwd).toBeNull();
  const second = updateLiveCwd(first, whole.slice(15));
  expect(second.cwd).toBe('/home/sam/project');
});

test('discards unrelated but complete OSC sequences (e.g. a title update)', () => {
  const state = updateLiveCwd(INITIAL_LIVE_CWD_STATE, '\x1b]0;some title\x07');
  expect(state.cwd).toBeNull();
  expect(state.residual).toBe('');
});

test('recordChunk/getLiveCwd/clearLiveCwd track state per session id', () => {
  recordChunk('live-cwd-session', '\x1b]7;file://h/a/b\x07');
  expect(getLiveCwd('live-cwd-session')).toBe('/a/b');
  clearLiveCwd('live-cwd-session');
  expect(getLiveCwd('live-cwd-session')).toBeNull();
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd apps/server && bun test src/server/liveCwd.test.ts`

Expected: FAIL because `./liveCwd` does not exist.

- [ ] **Step 3: Implement the OSC 7 parser and per-session store**

Create `apps/server/src/server/liveCwd.ts`:

```ts
const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const FILE_URI_RE = /^file:\/\/[^/]*(\/.*)$/;

export interface LiveCwdState {
  cwd: string | null;
  residual: string;
}

export const INITIAL_LIVE_CWD_STATE: LiveCwdState = { cwd: null, residual: '' };

// Bounded so a chunk with no OSC 7 (or a stray unrelated escape) can't grow
// this without limit — an OSC 7 payload is a hostname + path, nowhere near
// this size.
const MAX_RESIDUAL = 4096;

// Scans one PTY output chunk for OSC 7 cwd reports — the same escape sequence
// terminal.ts's dispatchOsc (ps === '7' branch) parses client-side, mirrored
// here so the server trusts its own view of the shell's cwd instead of a
// value relayed back by the network client. `state.residual` carries a
// possibly incomplete escape sequence split across two chunks, the same
// streaming-boundary problem pty.ts's attach() already solves for UTF-8.
export function updateLiveCwd(state: LiveCwdState, chunk: string): LiveCwdState {
  const joined = state.residual + chunk;
  let cwd = state.cwd;
  let consumed = 0;
  OSC7_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC7_RE.exec(joined))) {
    const fileMatch = FILE_URI_RE.exec(m[1]);
    if (fileMatch) {
      try {
        cwd = decodeURIComponent(fileMatch[1]);
      } catch {
        cwd = fileMatch[1];
      }
    }
    consumed = OSC7_RE.lastIndex;
  }
  const tail = joined.slice(consumed);
  const oscStart = tail.lastIndexOf('\x1b]');
  if (oscStart === -1) return { cwd, residual: '' };
  const rest = tail.slice(oscStart);
  const residual = /\x07|\x1b\\/.test(rest) ? '' : rest.slice(-MAX_RESIDUAL);
  return { cwd, residual };
}

const stateBySession = new Map<string, LiveCwdState>();

export function recordChunk(sessionId: string, chunk: string): void {
  const prev = stateBySession.get(sessionId) ?? INITIAL_LIVE_CWD_STATE;
  stateBySession.set(sessionId, updateLiveCwd(prev, chunk));
}

export function getLiveCwd(sessionId: string): string | null {
  return stateBySession.get(sessionId)?.cwd ?? null;
}

export function clearLiveCwd(sessionId: string): void {
  stateBySession.delete(sessionId);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/server && bun test src/server/liveCwd.test.ts`

Expected: all 7 assertions pass.

- [ ] **Step 5: Wire it into the PTY output pipe**

In `apps/server/src/server/pty.ts:14`, add the import next to the existing `db` import:

```ts
import { addTerminalLog, deleteSession, getSession, upsertSession } from './db';
import { clearLiveCwd, recordChunk } from './liveCwd';
```

In `flushOutput` (currently lines 180-186), record the chunk before it's logged:

```ts
  const flushOutput = () => {
    if (pendingOutput.length === 0) return;
    const text = pendingOutput.join('');
    pendingOutput = [];
    recordChunk(id, text);
    const logId = addTerminalLog(id, text);
    broadcast(id, { type: 'output', chunk: text, id: logId });
  };
```

In the exit branch (currently lines 198-211), clear the session's tracked cwd right after it's removed from `instances`:

```ts
    } else if (msg.t === 'x') {
      exited = true;
      const tail = decoder.decode();
      if (tail) pendingOutput.push(tail);
      flushOutput();
      console.log(`PTY process for session "${id}" exited with code ${msg.code}`);
      const sess = getSession(id);
      upsertSession(id, sess?.command ?? 'bash', 'stopped');
      broadcast(id, { type: 'exit', exitCode: msg.code });
      instances.get(id)?.subscribers.clear();
      instances.delete(id);
      clearLiveCwd(id);
    }
```

- [ ] **Step 6: Verify server typecheck and commit**

Run: `cd apps/server && bun test && bun --cwd . typecheck`

Expected: all server tests pass, no type errors.

```bash
git add apps/server/src/server/liveCwd.ts apps/server/src/server/liveCwd.test.ts apps/server/src/server/pty.ts
git commit -m "feat(server): track each session's live cwd from its own OSC 7 reports"
```

### Task 2: Resolve the nearest git root for a live cwd

**Files:**
- Create: `apps/server/src/server/gitRoot.ts`
- Create: `apps/server/src/server/gitRoot.test.ts`

**Interfaces:**
- Consumes: nothing (takes a plain `cwd: string`).
- Produces: `resolveGitRoot(cwd: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/server/gitRoot.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveGitRoot } from './gitRoot';

test('resolves the git top-level for a nested cwd inside a repo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitroot-'));
  try {
    execSync('git init -q', { cwd: root });
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    expect(resolveGitRoot(path.join(root, 'src', 'nested'))).toBe(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to the cwd itself when it is not inside a git repo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-notgit-'));
  try {
    expect(resolveGitRoot(dir)).toBe(realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd apps/server && bun test src/server/gitRoot.test.ts`

Expected: FAIL because `./gitRoot` does not exist.

- [ ] **Step 3: Implement resolution**

Create `apps/server/src/server/gitRoot.ts`:

```ts
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Resolves the nearest git repository root containing `cwd`, or `cwd` itself
// if it isn't inside a git working tree. Recomputed on every call — a
// session's cwd can point at a different project between requests (the user
// just `cd`'d), so nothing here is cached.
export function resolveGitRoot(cwd: string): string {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return realpathSync(top || cwd);
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd apps/server && bun test src/server/gitRoot.test.ts`

Expected: both assertions pass.

```bash
git add apps/server/src/server/gitRoot.ts apps/server/src/server/gitRoot.test.ts
git commit -m "feat(server): resolve the nearest git root for a live cwd"
```

### Task 3: Read a git diff summary and per-file diff

**Files:**
- Create: `apps/server/src/server/gitDiff.ts`
- Create: `apps/server/src/server/gitDiff.test.ts`

**Interfaces:**
- Consumes: a `root: string` (from `resolveGitRoot`).
- Produces: `readDiffSummary(root): { files: DiffFileStat[] }`, `readDiff(root, path?): { diff: string; truncated: boolean }`, `GitDiffError` with `status: 400 | 404`, `DiffFileStat = { path: string; insertions: number; deletions: number }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/server/gitDiff.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitDiffError, readDiff, readDiffSummary } from './gitDiff';

function withRepo(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitdiff-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('summarizes an unstaged change against HEAD', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    const summary = readDiffSummary(root);
    expect(summary.files).toEqual([{ path: 'main.ts', insertions: 1, deletions: 1 }]);
  });
});

test('returns the unified diff for a single file', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    const { diff, truncated } = readDiff(root, 'main.ts');
    expect(truncated).toBe(false);
    expect(diff).toContain('-export const answer = 42;');
    expect(diff).toContain('+export const answer = 43;');
  });
});

test('rejects a traversal path', () => {
  withRepo((root) => {
    expect(() => readDiff(root, '../secret.txt')).toThrow(GitDiffError);
  });
});

test('truncates a diff larger than 1 MiB and reports truncated: true', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'x'.repeat(1_048_577));
    const { diff, truncated } = readDiff(root);
    expect(truncated).toBe(true);
    expect(diff.length).toBe(1_048_576);
  });
});

test('reports an error for a non-repo root', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-notgit-'));
  try {
    expect(() => readDiffSummary(dir)).toThrow(GitDiffError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd apps/server && bun test src/server/gitDiff.test.ts`

Expected: FAIL because `./gitDiff` does not exist.

- [ ] **Step 3: Implement the reader**

Create `apps/server/src/server/gitDiff.ts`:

```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_DIFF_BYTES = 1_048_576;

export class GitDiffError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

function validatePath(requestedPath: string | undefined) {
  if (requestedPath === undefined) return;
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
    throw new GitDiffError(400, 'invalid file path');
  }
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES + 65_536,
  });
  if (result.status !== 0) throw new GitDiffError(404, 'not a git repository');
  return result.stdout;
}

export function readDiffSummary(root: string): { files: DiffFileStat[] } {
  const out = runGit(root, ['diff', 'HEAD', '--numstat']);
  const files = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [insertions, deletions, filePath] = line.split('\t');
      return {
        path: filePath,
        insertions: insertions === '-' ? 0 : Number(insertions),
        deletions: deletions === '-' ? 0 : Number(deletions),
      };
    });
  return { files };
}

export function readDiff(root: string, requestedPath?: string): { diff: string; truncated: boolean } {
  validatePath(requestedPath);
  const args = ['diff', 'HEAD'];
  if (requestedPath) args.push('--', requestedPath);
  const out = runGit(root, args);
  if (out.length > MAX_DIFF_BYTES) return { diff: out.slice(0, MAX_DIFF_BYTES), truncated: true };
  return { diff: out, truncated: false };
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd apps/server && bun test src/server/gitDiff.test.ts`

Expected: all 5 assertions pass.

```bash
git add apps/server/src/server/gitDiff.ts apps/server/src/server/gitDiff.test.ts
git commit -m "feat(server): read a git diff summary and per-file unified diff"
```

### Task 4: Rewire the file route and add diff routes

**Files:**
- Modify: `apps/server/src/server/app.ts:1-21` (imports), `apps/server/src/server/app.ts:146-159` (`/file` route)
- Modify: `apps/server/src/server/workspaceFile.api.test.ts`
- Create: `apps/server/src/server/gitDiff.api.test.ts`

**Interfaces:**
- Consumes: `getLiveCwd`/`recordChunk`/`clearLiveCwd` (Task 1), `resolveGitRoot` (Task 2), `readDiffSummary`/`readDiff`/`GitDiffError` (Task 3), `readWorkspaceFile`/`WorkspaceFileError` (existing).
- Produces: `GET /api/sessions/:id/file?path=` (client no longer sends `cwd`), `GET /api/sessions/:id/diff/summary`, `GET /api/sessions/:id/diff?path=`.

- [ ] **Step 1: Rewrite the failing file-route test for live-cwd semantics**

Replace the contents of `apps/server/src/server/workspaceFile.api.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { getAuthHash, setAuthHash, upsertSession } from './db';
import { clearLiveCwd, recordChunk } from './liveCwd';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

async function ensureAuth() {
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
}

function osc7(root: string) {
  return `\x1b]7;file://host${root}\x07`;
}

test('GET /api/sessions/:id/file serves workspace text once the shell has reported its cwd', async () => {
  const previousAuthHash = getAuthHash();
  await ensureAuth();
  const root = mkdtempSync(path.join(tmpdir(), 'tether-file-api-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
    upsertSession('file-rooted', 'bash', 'running');
    recordChunk('file-rooted', osc7(path.join(root, 'src')));

    const ok = await app.request(`/api/sessions/file-rooted/file?path=${encodeURIComponent('main.ts')}`, {
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: 'src/main.ts', content: 'export const answer = 42;\n' });

    upsertSession('file-pending', 'bash', 'running');
    const pending = await app.request('/api/sessions/file-pending/file?path=main.ts', { headers: AUTH });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: 'waiting for shell to report its working directory' });

    const bad = await app.request(
      `/api/sessions/file-rooted/file?path=${encodeURIComponent('../secret.txt')}`,
      { headers: AUTH },
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('content');
    expect(body.error).toBeDefined();
  } finally {
    clearLiveCwd('file-rooted');
    clearLiveCwd('file-pending');
    rmSync(root, { recursive: true, force: true });
    setAuthHash(previousAuthHash);
  }
});
```

- [ ] **Step 2: Write the failing diff-route test**

Create `apps/server/src/server/gitDiff.api.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { getAuthHash, setAuthHash, upsertSession } from './db';
import { clearLiveCwd, recordChunk } from './liveCwd';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

async function ensureAuth() {
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
}

function osc7(root: string) {
  return `\x1b]7;file://host${root}\x07`;
}

test('diff routes summarize and return an in-progress change', async () => {
  const previousAuthHash = getAuthHash();
  await ensureAuth();
  const root = mkdtempSync(path.join(tmpdir(), 'tether-diff-api-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');

    upsertSession('diff-session', 'bash', 'running');
    recordChunk('diff-session', osc7(root));

    const summary = await app.request('/api/sessions/diff-session/diff/summary', { headers: AUTH });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({ files: [{ path: 'main.ts', insertions: 1, deletions: 1 }] });

    const diff = await app.request(`/api/sessions/diff-session/diff?path=${encodeURIComponent('main.ts')}`, {
      headers: AUTH,
    });
    expect(diff.status).toBe(200);
    const body = (await diff.json()) as { diff: string; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.diff).toContain('+export const answer = 43;');

    upsertSession('diff-pending', 'bash', 'running');
    const pending = await app.request('/api/sessions/diff-pending/diff/summary', { headers: AUTH });
    expect(pending.status).toBe(409);
  } finally {
    clearLiveCwd('diff-session');
    clearLiveCwd('diff-pending');
    rmSync(root, { recursive: true, force: true });
    setAuthHash(previousAuthHash);
  }
});
```

- [ ] **Step 3: Confirm both test files fail**

Run: `cd apps/server && bun test src/server/workspaceFile.api.test.ts src/server/gitDiff.api.test.ts`

Expected: FAIL — the file route still reads `session.workspace_root` and a `cwd` query param, and the diff routes don't exist yet.

- [ ] **Step 4: Rewire the routes**

In `apps/server/src/server/app.ts`, replace the import block (currently lines 8-21):

```ts
import { getAuthHash, getLogs, getSession, listSessions, renameSession, setAuthHash } from './db';
import { GitDiffError, readDiff, readDiffSummary } from './gitDiff';
import { resolveGitRoot } from './gitRoot';
import { getLiveCwd } from './liveCwd';
import { PRESENT_CONTROL_TOKEN_FILE, UPLOADS_DIR } from './paths';
import { createControlToken, PresentationRegistry, resolvePresentationFile } from './presentations';
import {
  getDefaultShell,
  killSession,
  resizeSession,
  type Subscriber,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { resolveUploadPath } from './upload';
import { readWorkspaceFile, WorkspaceFileError } from './workspaceFile';
```

Replace the `/file` route (currently lines 146-159) with the rewired route plus the two new diff routes:

```ts
app.get('/api/sessions/:id/file', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readWorkspaceFile(resolveGitRoot(cwd), c.req.query('path') ?? '', cwd));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.get('/api/sessions/:id/diff/summary', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readDiffSummary(resolveGitRoot(cwd)));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.get('/api/sessions/:id/diff', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readDiff(resolveGitRoot(cwd), c.req.query('path')));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
```

- [ ] **Step 5: Verify and commit**

Run: `cd apps/server && bun test`

Expected: every server test passes, including the two rewritten/new API test files.

```bash
git add apps/server/src/server/app.ts apps/server/src/server/workspaceFile.api.test.ts apps/server/src/server/gitDiff.api.test.ts
git commit -m "feat(server): serve file/diff routes from a server-tracked live cwd"
```

### Task 5: Build the mobile diff view

**Files:**
- Create: `apps/mobile/src/diffView.ts`
- Create: `apps/mobile/src/diffView.test.ts`
- Create: `apps/mobile/src/DiffView.tsx`

**Interfaces:**
- Produces: `DiffFileStat = { path: string; insertions: number; deletions: number }`, `DiffSummary = { files: DiffFileStat[] }`, `totalChanges(summary): number`, `<DiffView summary diffLoading selectedPath diffText onSelectFile onDeselectFile onBack />`.
- Consumes: existing theme (`useAppTheme`) and React Native primitives only, same as `FileViewer`.

- [ ] **Step 1: Write the failing helper test**

Create `apps/mobile/src/diffView.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { totalChanges } from './diffView';

test('totalChanges sums insertions and deletions across files', () => {
  expect(totalChanges({ files: [] })).toBe(0);
  expect(
    totalChanges({
      files: [
        { path: 'a.ts', insertions: 3, deletions: 1 },
        { path: 'b.ts', insertions: 0, deletions: 2 },
      ],
    }),
  ).toBe(6);
});
```

- [ ] **Step 2: Confirm the test fails**

Run: `cd apps/mobile && bun test src/diffView.test.ts`

Expected: FAIL because `./diffView` does not exist.

- [ ] **Step 3: Implement the types/helper and the viewer component**

Create `apps/mobile/src/diffView.ts`:

```ts
export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  files: DiffFileStat[];
}

export function totalChanges(summary: DiffSummary): number {
  return summary.files.reduce((sum, f) => sum + f.insertions + f.deletions, 0);
}
```

Create `apps/mobile/src/DiffView.tsx`:

```tsx
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { DiffSummary } from './diffView';

export function DiffView({
  summary,
  selectedPath,
  diffText,
  diffLoading,
  onSelectFile,
  onDeselectFile,
  onBack,
}: {
  summary: DiffSummary;
  selectedPath: string | null;
  diffText: string | null;
  diffLoading: boolean;
  onSelectFile: (path: string) => void;
  onDeselectFile: () => void;
  onBack: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={selectedPath ? 'Back to changed files' : 'Back to terminal'}
          onPress={selectedPath ? onDeselectFile : onBack}
          style={styles.back}
        >
          <Text style={{ color: theme.colors.accent }}>Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>
          {selectedPath ?? 'Changes'}
        </Text>
      </View>
      {selectedPath ? (
        diffLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : (
          <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
            <ScrollView horizontal contentContainerStyle={styles.horizontal}>
              <Text selectable style={[styles.code, { color: theme.terminal.fg }]}>
                {diffText ?? ''}
              </Text>
            </ScrollView>
          </ScrollView>
        )
      ) : summary.files.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>No changes</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {summary.files.map((file) => (
            <TouchableOpacity key={file.path} style={styles.fileRow} onPress={() => onSelectFile(file.path)}>
              <Text numberOfLines={1} style={[styles.filePath, { color: theme.colors.text }]}>
                {file.path}
              </Text>
              <Text style={styles.fileStat}>
                <Text style={{ color: theme.colors.success }}>+{file.insertions}</Text>{' '}
                <Text style={{ color: theme.colors.danger }}>-{file.deletions}</Text>
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vertical: { flex: 1 },
  content: { padding: 16 },
  horizontal: { minWidth: '100%' },
  code: { fontFamily: 'monospace', fontSize: 14, lineHeight: 20 },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
});
```

- [ ] **Step 4: Verify and commit**

Run: `cd apps/mobile && bun test src/diffView.test.ts && npx tsc --noEmit`

Expected: helper test and mobile typecheck pass.

```bash
git add apps/mobile/src/diffView.ts apps/mobile/src/diffView.test.ts apps/mobile/src/DiffView.tsx
git commit -m "feat(mobile): add read-only git diff view"
```

### Task 6: Wire the diff view into the app facade and screen

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx:163-164` (state), `apps/mobile/src/useTetherApp.tsx:435` (`switchTo`), `apps/mobile/src/useTetherApp.tsx:609` (`selectPresentation`), `apps/mobile/src/useTetherApp.tsx:1282-1315` (`openFile`/`closeFile` area), `apps/mobile/src/useTetherApp.tsx:1495-1497` (facade return)
- Modify: `apps/mobile/src/TerminalScreen.tsx:62` (import), `apps/mobile/src/TerminalScreen.tsx:82` (destructure), `apps/mobile/src/TerminalScreen.tsx:126`/`145`/`152-157` (effect deps), `apps/mobile/src/TerminalScreen.tsx:162` (`terminalVisible`), `apps/mobile/src/TerminalScreen.tsx:283` (render branch), `apps/mobile/src/TerminalScreen.tsx:395-415` (`OverflowMenu` usage)
- Modify: `apps/mobile/src/OverflowMenu.tsx`

**Interfaces:**
- Produces: facade values `diffSummary`, `diffSelectedPath`, `diffText`, `diffLoading`, `openDiff()`, `closeDiff()`, `selectDiffFile(path)`, `deselectDiffFile()`.
- Preserves: `fileView`/`activePresentation` navigation, terminal socket/scroll state, `OverflowMenu`'s existing props.

- [ ] **Step 1: Add facade state and handlers in `useTetherApp.tsx`**

Add the import next to the existing `LinkTarget` import:

```ts
import type { LinkTarget } from './links';
import type { DiffSummary } from './diffView';
```

Add state next to `fileView`/`fileLoading` (currently lines 163-164):

```ts
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffSummary, setDiffSummary] = useState<DiffSummary | null>(null);
  const [diffSelectedPath, setDiffSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
```

In `switchTo` (currently line 433-435), close the diff view alongside the file view:

```ts
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    setFileView(null);
    closeDiff();
```

In `selectPresentation` (currently lines 608-610), do the same:

```ts
  const selectPresentation = (id: string) => {
    setFileView(null);
    closeDiff();
    setActivePresentationId(id);
  };
```

Remove the now-unused client `cwd` param from `openFile`'s fetch (currently lines 1293-1302) — the server resolves its own root:

```ts
    setFileLoading(true);
    try {
      const sessionId = activeIdRef.current;
      const query = new URLSearchParams({ path: target.path });
      const res = await fetch(`${httpBase(serverIp, port)}/api/sessions/${sessionId}/file?${query}`, {
        headers: authHeaders(passwordRef.current),
      });
```

Add the diff handlers right after `closeFile`/`openFile` (currently ending at line 1315):

```ts
  const closeDiff = useCallback(() => {
    setDiffSummary(null);
    setDiffSelectedPath(null);
    setDiffText(null);
  }, []);
  const deselectDiffFile = useCallback(() => {
    setDiffSelectedPath(null);
    setDiffText(null);
  }, []);
  const selectDiffFile = useCallback(
    async (filePath: string) => {
      setDiffSelectedPath(filePath);
      setDiffText(null);
      setDiffLoading(true);
      try {
        const sessionId = activeIdRef.current;
        const query = new URLSearchParams({ path: filePath });
        const res = await fetch(`${httpBase(serverIp, port)}/api/sessions/${sessionId}/diff?${query}`, {
          headers: authHeaders(passwordRef.current),
        });
        const body = (await res.json().catch(() => ({}))) as { diff?: string; error?: string };
        if (!res.ok || typeof body.diff !== 'string') {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        setDiffText(body.diff);
      } catch (error) {
        void notify('Could not load diff', String(error), 'error');
      } finally {
        setDiffLoading(false);
      }
    },
    [serverIp, port],
  );
  const openDiff = useCallback(async () => {
    setDiffSummary({ files: [] });
    setDiffSelectedPath(null);
    setDiffText(null);
    try {
      const sessionId = activeIdRef.current;
      const res = await fetch(`${httpBase(serverIp, port)}/api/sessions/${sessionId}/diff/summary`, {
        headers: authHeaders(passwordRef.current),
      });
      const body = (await res.json().catch(() => ({}))) as { files?: DiffSummary['files']; error?: string };
      if (!res.ok || !Array.isArray(body.files)) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      if (activeIdRef.current === sessionId) setDiffSummary({ files: body.files });
    } catch (error) {
      void notify('Could not load changes', String(error), 'error');
      setDiffSummary(null);
    }
  }, [serverIp, port]);
```

Add the new values to the facade return (currently the single-line return at line 1495-1497), inserting them right after `fileView, fileLoading, openFile, closeFile,`:

```
fileView, fileLoading, openFile, closeFile, diffSummary, diffSelectedPath, diffText, diffLoading, openDiff, closeDiff, selectDiffFile, deselectDiffFile,
```

- [ ] **Step 2: Confirm mobile typecheck fails until the screen is wired**

Run: `cd apps/mobile && npx tsc --noEmit`

Expected: FAIL — `TerminalScreen.tsx` destructures `openDiff`/`closeDiff`/etc. that don't exist there yet (this step just confirms the facade changed; the screen wiring below fixes it).

- [ ] **Step 3: Wire `TerminalScreen.tsx`**

Add the import next to `FileViewer` (currently line 62):

```ts
import { FileViewer } from './FileViewer';
import { DiffView } from './DiffView';
```

Add the new facade values to the big destructure (currently line 82), inserting them right after `fileView, fileLoading, closeFile,`:

```
fileView, fileLoading, closeFile, diffSummary, diffSelectedPath, diffText, diffLoading, openDiff, closeDiff, selectDiffFile, deselectDiffFile,
```

Extend the three effects that currently key off `fileView` (lines 126, 145, 152-157) to also key off `diffSummary`:

```ts
  }, [uploadFile, activePresentation, fileView, diffSummary]);
```

```ts
  }, [activePresentation, fileView, diffSummary]);
```

```ts
  useEffect(() => {
    if (activePresentation || fileView || diffSummary) {
      setMenuOpen(false);
      setSelectionViewOpen(false);
    }
  }, [activePresentation, fileView, diffSummary, setMenuOpen, setSelectionViewOpen]);
```

Update `terminalVisible` (currently line 162):

```ts
  const terminalVisible = !fileView && !diffSummary && !activePresentation;
```

Update the render branch (currently line 283) to check `diffSummary` between `fileView` and `activePresentation`:

```tsx
          {fileView ? (
            <FileViewer file={fileView} onBack={closeFile} />
          ) : diffSummary ? (
            <DiffView
              summary={diffSummary}
              selectedPath={diffSelectedPath}
              diffText={diffText}
              diffLoading={diffLoading}
              onSelectFile={selectDiffFile}
              onDeselectFile={deselectDiffFile}
              onBack={closeDiff}
            />
          ) : activePresentation ? (
```

Pass the new action to `OverflowMenu` (currently lines 395-415), adding `onViewChanges` alongside the existing props:

```tsx
          {terminalVisible && <OverflowMenu
            visible={menuOpen}
            onClose={() => setMenuOpen(false)}
            onRename={openRename}
            onViewChanges={() => { setMenuOpen(false); void openDiff(); }}
            fontSize={fontSize}
```

- [ ] **Step 4: Add the menu entry in `OverflowMenu.tsx`**

Add `onViewChanges` to the prop type (next to `onRename`):

```ts
  onRename,
  onViewChanges,
```
```ts
  onRename: () => void;
  onViewChanges: () => void;
```

Add a row right after the "Rename terminal" row:

```tsx
          <TouchableOpacity style={styles.menuRow} onPress={onRename}>
            <Feather name="edit-2" size={16} color={theme.colors.text} />
            <Text style={styles.menuRowText}>Rename terminal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuRow} onPress={onViewChanges}>
            <Feather name="git-branch" size={16} color={theme.colors.text} />
            <Text style={styles.menuRowText}>View changes</Text>
          </TouchableOpacity>
```

- [ ] **Step 5: Run full mobile verification**

Run:

```bash
cd apps/mobile && bun test && npx tsc --noEmit && bun run lint
```

Expected: all mobile tests pass, no type errors, lint clean.

- [ ] **Step 6: Manual verification and commit**

Manually verify: `cd` into a project outside the daemon's launch directory (the scenario that was broken before this plan), make an edit with an agent, open the overflow menu → "View changes", confirm the changed-files list and per-file diff, and confirm Back returns to the terminal without disrupting the session. Also confirm opening a file link still works from the same session (exercising the rewired `/file` route with no `cwd` param).

```bash
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/OverflowMenu.tsx
git commit -m "feat(mobile): open a read-only git diff view from the overflow menu"
```
