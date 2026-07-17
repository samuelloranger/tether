# Terminal File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open workspace-relative paths printed in a terminal in a native, read-only full-screen viewer.

**Architecture:** New sessions persist a canonical workspace root. A small server reader validates and reads an in-workspace text file for an authenticated API route. The mobile client turns terminal links into typed external/file targets, then uses the existing app facade to show a native viewer without changing socket or terminal state.

**Tech Stack:** Bun, TypeScript, Hono, SQLite, Expo React Native/react-native-web.

## Global Constraints

- No global store, context, dependency, WebView, editor, syntax highlighter, search, refresh, or file browser.
- HTTP(S) links retain their existing external-open behavior; file targets are relative only.
- Persist a canonical root for newly created sessions only. Legacy rows stay rootless and return `409` until restarted.
- Validate optional OSC 7 cwd and the resolved target by realpath containment below the stored root.
- Reject `..`, absolute targets, directories, binary/non-UTF-8 files, symlink escapes, and files larger than 1 MiB.
- Mobile activates links by tap; desktop requires Ctrl/Cmd+click.
- Run Bun tests, mobile typecheck/lint, and Tauri `cargo build` before merge.

---

### Task 1: Persist the session workspace root

**Files:**
- Modify: `apps/server/src/server/db.ts`
- Modify: `apps/server/src/server/db.test.ts`
- Modify: `apps/server/src/server/pty.ts`

**Interfaces:**
- Produces: `Session.workspace_root: string | null`.
- Produces: `upsertSession(id, command, status?, workspaceRoot?)` which writes the root only when inserting a new row.
- Consumes: `doStartSession()` captures `realpathSync(process.cwd())` before its initial upsert.

- [ ] **Step 1: Add the failing database assertion**

Add this test block before the final `console.log` in `db.test.ts`:

```ts
{
  upsertSession('term-root', 'bash', 'running', '/tmp/tether-workspace');
  ok(getSession('term-root')!.workspace_root === '/tmp/tether-workspace', 'new session stores workspace root');
  upsertSession('term-root', 'zsh', 'stopped', '/tmp/other-workspace');
  const session = getSession('term-root')!;
  ok(session.workspace_root === '/tmp/tether-workspace', 'workspace root is immutable');
  ok(session.command === 'zsh' && session.status === 'stopped', 'other session fields still update');
}
```

- [ ] **Step 2: Confirm the test fails**

Run: `cd apps/server && TETHER_DB_PATH=/tmp/tether-file-viewer-db-$$.db bun run src/server/db.test.ts`

Expected: failure because `workspace_root` and the fourth `upsertSession` parameter do not exist.

- [ ] **Step 3: Add migration and write-once insert value**

Add migration 6 and extend `Session`:

```ts
{
  version: 6,
  name: 'session_workspace_root',
  up: `ALTER TABLE sessions ADD COLUMN workspace_root TEXT;`,
},

export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
  name: string | null;
  pruned_before: number;
  workspace_root: string | null;
}
```

Change the database write to preserve the root on conflicts:

```ts
export function upsertSession(id: string, command: string, status: 'running' | 'stopped' = 'running', workspaceRoot?: string) {
  db.query(`
    INSERT INTO sessions (id, command, status, workspace_root)
    VALUES ($id, $command, $status, $workspaceRoot)
    ON CONFLICT(id) DO UPDATE SET command = excluded.command, status = excluded.status
  `).run({ $id: id, $command: command, $status: status, $workspaceRoot: workspaceRoot ?? null });
}
```

In `doStartSession`, import `realpathSync` and call:

```ts
upsertSession(id, command, 'running', realpathSync(process.cwd()));
```

Do not add a root to any reattach/stopped-session updates.

- [ ] **Step 4: Verify and commit**

Run: `cd apps/server && TETHER_DB_PATH=/tmp/tether-file-viewer-db-$$.db bun run src/server/db.test.ts`

Expected: exits 0 with three additional assertions.

```bash
git add apps/server/src/server/db.ts apps/server/src/server/db.test.ts apps/server/src/server/pty.ts
git commit -m "feat(server): record workspace root per terminal session"
```

### Task 2: Add one safe workspace-file reader and its API route

**Files:**
- Create: `apps/server/src/server/workspaceFile.ts`
- Create: `apps/server/src/server/workspaceFile.test.ts`
- Create: `apps/server/src/server/workspaceFile.api.test.ts`
- Modify: `apps/server/src/server/app.ts`

**Interfaces:**
- Produces: `readWorkspaceFile(root, requestedPath, cwd?): { path: string; content: string }`.
- Produces: `WorkspaceFileError` with `status: 400 | 404 | 413 | 415`.
- Produces: authenticated `GET /api/sessions/:id/file?path=<relative>&cwd=<optional-absolute>`.

- [ ] **Step 1: Write failing reader tests**

Create `workspaceFile.test.ts` with Bun tests using a `mkdtempSync` root. Its cases must assert:

```ts
expect(readWorkspaceFile(root, 'main.ts', path.join(root, 'src'))).toEqual({
  path: 'src/main.ts', content: 'export const answer = 42;\n',
});
expect(() => readWorkspaceFile(root, '../secret.txt')).toThrow(WorkspaceFileError);
expect(() => readWorkspaceFile(root, path.join(root, 'main.ts'))).toThrow(WorkspaceFileError);
expect(() => readWorkspaceFile(root, 'dir')).toThrow(WorkspaceFileError);
expect(() => readWorkspaceFile(root, 'binary.bin')).toThrow(WorkspaceFileError);
expect(() => readWorkspaceFile(root, 'large.txt')).toThrow(WorkspaceFileError);
expect(() => readWorkspaceFile(root, 'escape.txt')).toThrow(WorkspaceFileError);
```

Make `binary.bin` contain a NUL, `large.txt` contain `1_048_577` bytes, and `escape.txt` be a symlink to a temp file outside `root`. After each rejected read, catch the error and assert the expected status: `400`, `415`, `413`, and `400` respectively.

- [ ] **Step 2: Confirm the reader test fails**

Run: `cd apps/server && bun test src/server/workspaceFile.test.ts`

Expected: FAIL because `./workspaceFile` does not exist.

- [ ] **Step 3: Implement the complete filesystem boundary**

Create `workspaceFile.ts`:

```ts
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 1_048_576;
const inside = (root: string, value: string) => value === root || value.startsWith(`${root}${path.sep}`);

export class WorkspaceFileError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415, message: string) { super(message); }
}

export function readWorkspaceFile(root: string, requestedPath: string, cwd?: string) {
  if (!requestedPath || path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..'))
    throw new WorkspaceFileError(400, 'invalid file path');
  const canonicalRoot = realpathSync(root);
  let base = canonicalRoot;
  if (cwd) {
    try { base = realpathSync(cwd); } catch { throw new WorkspaceFileError(400, 'invalid working directory'); }
    if (!inside(canonicalRoot, base)) throw new WorkspaceFileError(400, 'working directory escapes workspace');
  }
  let file: string;
  try { file = realpathSync(path.resolve(base, requestedPath)); }
  catch { throw new WorkspaceFileError(404, 'file not found'); }
  if (!inside(canonicalRoot, file)) throw new WorkspaceFileError(400, 'file escapes workspace');
  if (statSync(file).isDirectory()) throw new WorkspaceFileError(415, 'path is a directory');
  const bytes = readFileSync(file);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new WorkspaceFileError(413, 'file is too large');
  if (bytes.includes(0)) throw new WorkspaceFileError(415, 'file is binary');
  try { return { path: path.relative(canonicalRoot, file), content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { throw new WorkspaceFileError(415, 'file is not UTF-8 text'); }
}
```

- [ ] **Step 4: Add the route and failing API contract test**

Add this route after `/api/sessions` in `app.ts`:

```ts
app.get('/api/sessions/:id/file', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  if (!session.workspace_root) return c.json({ error: 'restart terminal to enable file viewing' }, 409);
  try {
    return c.json(readWorkspaceFile(session.workspace_root, c.req.query('path') ?? '', c.req.query('cwd')));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
```

Create `workspaceFile.api.test.ts` following `presentations.api.test.ts`. Configure `setAuthHash(await Bun.password.hash('test-password', { algorithm: 'argon2id' }))`, create a rooted session with `upsertSession`, and call `app.request()` with `Authorization: Bearer test-password`. Assert a `200` body exactly equal to `{ path, content }`, `409` for a rootless legacy row, and `400` for `../secret.txt` with no `content` key.

- [ ] **Step 5: Run server verification and commit**

Run: `cd apps/server && bun test src/server/workspaceFile.test.ts src/server/workspaceFile.api.test.ts`

Expected: all nested-path, traversal, symlink, binary, size, legacy, and authenticated-route assertions pass.

```bash
git add apps/server/src/server/workspaceFile.ts apps/server/src/server/workspaceFile.test.ts apps/server/src/server/workspaceFile.api.test.ts apps/server/src/server/app.ts
git commit -m "feat(server): serve session workspace files safely"
```

### Task 3: Upgrade terminal links to typed external and file targets

**Files:**
- Modify: `apps/mobile/src/links.ts`
- Create: `apps/mobile/src/links.test.ts`
- Modify: `apps/mobile/src/terminal.ts`
- Modify: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Produces: `LinkTarget = { kind: 'external'; url: string } | { kind: 'file'; path: string; line?: number; column?: number }`.
- Produces: `parseFileTarget(token)` and changes `LinkSpan`, `urlColumns`, and `RunSegment` to carry `target` instead of `url`.
- Preserves: explicit OSC 8 and HTTP(S) links as external targets, with OSC 8 still winning over regex targets.

- [ ] **Step 1: Write failing parsing tests**

Create `links.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { computeLinkSpans, parseFileTarget } from './links';

test('parses workspace files and source locations', () => {
  expect(parseFileTarget('docs/superpowers/specs/design.md')).toEqual({ kind: 'file', path: 'docs/superpowers/specs/design.md' });
  expect(parseFileTarget('apps/mobile/src/App.tsx:42:9')).toEqual({ kind: 'file', path: 'apps/mobile/src/App.tsx', line: 42, column: 9 });
  expect(parseFileTarget('/etc/passwd')).toBeNull();
  expect(parseFileTarget('../secret.txt')).toBeNull();
  expect(parseFileTarget('plain-word')).toBeNull();
});

test('soft-wrapped file links carry the whole typed target', () => {
  const path = 'docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md';
  const spans = computeLinkSpans([path.slice(0, 24), path.slice(24)], [true, false]);
  expect(spans[0][0].target).toEqual({ kind: 'file', path });
  expect(spans[1][0].target).toEqual({ kind: 'file', path });
});
```

Update existing `terminal.test.ts` URL expectations, for example:

```ts
eq(links[0].target, { kind: 'external', url: 'https://example.com/path' }, 'regex-detected URL is correct');
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd apps/mobile && bun test src/links.test.ts src/terminal.test.ts`

Expected: FAIL because `LinkSpan.target` and `parseFileTarget` do not exist.

- [ ] **Step 3: Implement typed reconstruction**

Use these exported shapes in `links.ts`:

```ts
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number };
export interface LinkSpan { start: number; end: number; target: LinkTarget; }
export interface RunSegment { text: string; target?: LinkTarget; }
```

Implement `parseFileTarget()` so a token must contain a slash and final extension, trims only trailing `)`, `]`, `,`, `.`, and `;`, and accepts positive `:line[:column]`. Do not generate file targets for absolute or `..` paths. Make `computeLinkSpans()` reconstruct both HTTP(S) external targets and file targets using the existing wrapped-row mapping. In `terminal.ts`, map OSC 8 URIs to `{ kind: 'external', url }` and update `linksEqual()`/`explicitLinkSpans()` for `target` equality.

- [ ] **Step 4: Verify and commit**

Run: `cd apps/mobile && bun test src/links.test.ts src/terminal.test.ts`

Expected: URL, OSC 8, source-location, and wrapped-file tests pass.

```bash
git add apps/mobile/src/links.ts apps/mobile/src/links.test.ts apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "feat(mobile): detect workspace file links in terminal output"
```

### Task 4: Build the native read-only viewer

**Files:**
- Create: `apps/mobile/src/fileViewer.ts`
- Create: `apps/mobile/src/fileViewer.test.ts`
- Create: `apps/mobile/src/FileViewer.tsx`

**Interfaces:**
- Produces: `FileView = { path: string; content: string; line?: number; column?: number }`.
- Produces: `lineOffset(content, line): number` and `<FileViewer file={file} onBack={fn} />`.
- Consumes: existing theme and React Native primitives only.

- [ ] **Step 1: Write the failing location helper test**

Create `fileViewer.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { lineOffset } from './fileViewer';

test('lineOffset clamps one-based source locations', () => {
  const content = 'one\ntwo\nthree\n';
  expect(lineOffset(content, 1)).toBe(0);
  expect(lineOffset(content, 3)).toBe(2);
  expect(lineOffset(content, 99)).toBe(3);
  expect(lineOffset(content, undefined)).toBe(0);
});
```

- [ ] **Step 2: Confirm the test fails**

Run: `cd apps/mobile && bun test src/fileViewer.test.ts`

Expected: FAIL because `./fileViewer` does not exist.

- [ ] **Step 3: Implement the viewer and minimal source-location helper**

Create `fileViewer.ts`:

```ts
export interface FileView { path: string; content: string; line?: number; column?: number; }
export function lineOffset(content: string, line?: number): number {
  return Math.max(0, Math.min(content.split('\n').length - 1, (line ?? 1) - 1));
}
```

Create `FileViewer.tsx` with a themed Back `TouchableOpacity`, workspace-relative path header, and horizontal/vertical `ScrollView` containing selectable monospaced text. Use a ref and this effect after layout:

```ts
useEffect(() => {
  scrollRef.current?.scrollTo({ y: lineOffset(file.content, file.line) * lineHeight, animated: false });
}, [file.content, file.line, lineHeight]);
```

Do not add an editor or virtualized renderer; the server's 1 MiB cap is the first-version memory boundary.

- [ ] **Step 4: Verify and commit**

Run: `cd apps/mobile && bun test src/fileViewer.test.ts && npx tsc --noEmit`

Expected: helper test and mobile typecheck pass.

```bash
git add apps/mobile/src/fileViewer.ts apps/mobile/src/fileViewer.test.ts apps/mobile/src/FileViewer.tsx
git commit -m "feat(mobile): add read-only terminal file viewer"
```

### Task 5: Wire activation, fetch, navigation, and full verification

**Files:**
- Modify: `apps/mobile/src/TermRow.tsx`
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`

**Interfaces:**
- Produces: `TermRow` prop `onOpenLink(target: LinkTarget): void`.
- Produces: facade values `fileView`, `fileLoading`, `openFile(target)`, and `closeFile()`.
- Preserves: external links, terminal socket/cache/scroll state, and presentation navigation.

- [ ] **Step 1: Add the failing callback contract**

Require this prop in `TermRow` and at its current construction call in `useTetherApp.tsx`:

```ts
onOpenLink: (target: LinkTarget) => void;
```

Run: `cd apps/mobile && npx tsc --noEmit`

Expected: FAIL until the terminal grid passes a handler.

- [ ] **Step 2: Delegate link activation from `TermRow`**

Remove direct `Linking`, `openExternalUrl`, and `notify` use from `TermRow`. Its pressed segment uses:

```tsx
onPress={(event) => {
  if (isDesktop) {
    const mods = event.nativeEvent as unknown as { ctrlKey?: boolean; metaKey?: boolean };
    if (!mods.ctrlKey && !mods.metaKey) return;
  }
  onOpenLink(seg.target!);
}}
```

Use `seg.target` in place of `seg.url` everywhere in the row. Add
`prev.onOpenLink === next.onOpenLink` to the memo comparator so a new facade
handler cannot be hidden behind a reused terminal row.

- [ ] **Step 3: Implement facade loading and fetch state**

In `useTetherApp.tsx`, add this state and handler, using its existing `httpBase`, `authHeaders`, `passwordRef`, `entryFor`, and `notify` helpers:

```ts
const [fileView, setFileView] = useState<FileView | null>(null);
const [fileLoading, setFileLoading] = useState(false);
const closeFile = () => setFileView(null);
const openFile = async (target: LinkTarget) => {
  if (target.kind === 'external') {
    try { await openExternalUrl(target.url); } catch (error) { void notify('Could not open link', String(error), 'error'); }
    return;
  }
  setFileLoading(true);
  try {
    const cwd = entryFor(activeIdRef.current).term.cwd;
    const query = new URLSearchParams({ path: target.path });
    if (cwd) query.set('cwd', cwd);
    const res = await fetch(`${httpBase(serverIp, port)}/api/sessions/${activeIdRef.current}/file?${query}`, { headers: authHeaders(passwordRef.current) });
    const body = (await res.json().catch(() => ({}))) as { path?: string; content?: string; error?: string };
    if (!res.ok || typeof body.path !== 'string' || typeof body.content !== 'string') throw new Error(body.error || `Request failed (${res.status})`);
    setFileView({ path: body.path, content: body.content, line: target.line, column: target.column });
  } catch (error) { void notify('Could not open file', String(error), 'error'); }
  finally { setFileLoading(false); }
};
```

Pass `onOpenLink={openFile}` to all `TermRow` instances and include the handler in the grid memo dependencies.

- [ ] **Step 4: Render viewer before presentation/terminal content**

In `TerminalScreen.tsx`, import `FileViewer`, destructure the four facade values, and branch:

```tsx
{fileView ? <FileViewer file={fileView} onBack={closeFile} /> : activePresentation ? (
  <>{/* existing PresentationBanner and PresentationView branch */}</>
) : (
  <>{/* existing terminal grid branch */}</>
)}
```

Render an `ActivityIndicator` overlay for `fileLoading`; keep the terminal mounted until a successful response sets `fileView`.

- [ ] **Step 5: Run automated and manual verification**

Run:

```bash
cd apps/server && bun test
cd ../mobile && bun test && npx tsc --noEmit && bun run lint
cd src-tauri && cargo build
```

Expected: all automated gates pass.

On mobile, tap `docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md` and `apps/mobile/src/TerminalScreen.tsx:74`; verify content, approximate line jump, and Back preserving the terminal. On desktop, verify only Ctrl/Cmd+click opens a path. Verify absolute/`..` paths, directories, missing files, and outside-workspace symlinks reveal no content and retain the terminal.

- [ ] **Step 6: Commit integration and record manual results**

```bash
git add apps/mobile/src/TermRow.tsx apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mobile): open terminal file links in-app"
```

Record exact manual results on the board. Create a new board task for any failed expectation instead of patching it during verification.
