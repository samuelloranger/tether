# Agent HTML Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex CLI and Claude Code open scoped local HTML previews in Tether desktop and iOS, with automatic reload and cleanup commands.

**Architecture:** An in-memory server registry owns each canonical preview root, its watcher, revision, and random capability URL. `tether present` authenticates only to a local-control route with a mode-0600 token. The mobile client polls authenticated metadata, displays terminal sessions and previews as peer workspace entries, and loads the capability URL in an iframe on web/Tauri or WebView on iOS.

**Tech Stack:** Bun, Hono, Node `fs.watch`, React Native/Expo SDK 57, react-native-webview, react-native-web, Tauri, Bun test, VitePress.

## Global Constraints

- Preview pages are display-only: no native message bridge, form callbacks, or authenticated Tether credentials.
- The only commands are `tether present <entry.html> [--project <name>] [--title <title>]`, `tether present reset [project-name]`, and `tether present agent-install [codex|claude]`.
- Resolve every entry and served asset with real paths; deny traversal and symlinks outside the canonical preview root.
- Do not persist previews, add a database migration, support arbitrary URLs, install lifecycle hooks, or change the terminal session protocol.
- Preserve desktop sidebar/hover/tabs behavior and mobile safe-area behavior.
- Install the Expo SDK 57-compatible WebView via `npx expo install react-native-webview`.

---

### Task 1: Build the scoped presentation registry

**Files:**
- Create: `apps/server/src/server/presentations.ts`
- Create: `apps/server/src/server/presentations.test.ts`
- Modify: `apps/server/src/server/paths.ts`

**Interfaces:**
- Produces `Presentation`, `PresentationRegistry`, `resolvePresentationFile`, and `createControlToken` for Task 2.

- [ ] **Step 1: Write the failing registry tests**

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PresentationRegistry, resolvePresentationFile } from './presentations';

test('creates metadata without exposing the filesystem root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-'));
  try {
    writeFileSync(path.join(root, 'index.html'), '<h1>Preview</h1>');
    const registry = new PresentationRegistry(10);
    const preview = registry.create({ entry: path.join(root, 'index.html'), title: 'Creneau UI' });
    expect(preview).toMatchObject({ title: 'Creneau UI', project: path.basename(root), revision: 0 });
    expect(preview.url).toMatch(/^\/preview\/[a-f0-9]+\/index\.html$/);
    expect(JSON.stringify(preview)).not.toContain(root);
    registry.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects traversal and symlink escapes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'tether-outside-'));
  try {
    writeFileSync(path.join(root, 'index.html'), 'ok');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    expect(() => resolvePresentationFile(root, '../secret.txt')).toThrow();
    expect(() => resolvePresentationFile(root, 'escape.txt')).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('debounces changes into one revision and reset stops matching previews', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-'));
  try {
    writeFileSync(path.join(root, 'index.html'), 'ok');
    writeFileSync(path.join(root, 'style.css'), 'body{}');
    const registry = new PresentationRegistry(10);
    const first = registry.create({ entry: path.join(root, 'index.html'), project: 'creneau' });
    registry.create({ entry: path.join(root, 'index.html'), project: 'creneau', title: 'Second' });
    writeFileSync(path.join(root, 'style.css'), 'body{color:red}');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.list().find((p) => p.id === first.id)?.revision).toBe(1);
    expect(registry.reset('creneau')).toBe(2);
    expect(registry.list()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `bun test apps/server/src/server/presentations.test.ts`

Expected: FAIL because `./presentations` is absent.

- [ ] **Step 3: Implement the registry and control-token helper**

```ts
export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
}

export function resolvePresentationFile(root: string, requested: string): string {
  const canonicalRoot = realpathSync(root);
  const candidate = realpathSync(path.resolve(canonicalRoot, requested));
  if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('preview path escapes its root');
  }
  return candidate;
}

export class PresentationRegistry {
  constructor(private readonly debounceMs = 150) {}
  create(input: { entry: string; project?: string; title?: string }): Presentation;
  list(): Presentation[];
  close(id: string): boolean;
  reset(project?: string): number;
  findByToken(token: string): InternalPresentation | null;
  dispose(): void;
}
```

Require an existing `.html` file, canonicalize its containing directory as the root, use `randomBytes(24).toString('hex')` for the capability token, and debounce `fs.watch(root, { recursive: true })` into a single revision increment. `list()` returns only public fields. `close`, `reset`, and `dispose` always close their `FSWatcher` handles. Add `PRESENT_CONTROL_TOKEN_FILE = path.join(STATE_DIR, 'present-control-token')`; `createControlToken` creates it once with `openSync(file, 'wx', 0o600)` and otherwise reads its trimmed value.

- [ ] **Step 4: Run the focused tests**

Run: `bun test apps/server/src/server/presentations.test.ts`

Expected: PASS for metadata privacy, canonical containment, revisioning, close, and project reset.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/presentations.ts apps/server/src/server/presentations.test.ts apps/server/src/server/paths.ts
git commit -m "feat(server): add scoped preview registry"
```

### Task 2: Add local-control routes and `tether present`

**Files:**
- Create: `apps/server/src/server/presentCli.ts`
- Create: `apps/server/src/server/presentCli.test.ts`
- Modify: `apps/server/src/server/app.ts`
- Modify: `apps/server/src/server/serve.ts`
- Modify: `apps/server/src/server/main.ts`

**Interfaces:**
- Consumes Task 1 registry and token file.
- Produces `parsePresentArgs`, `runPresent`, `installAgentSkill`, and the authenticated client endpoints used by Task 3.

- [ ] **Step 1: Write failing CLI tests**

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAgentSkill, parsePresentArgs } from './presentCli';

test('parses only the documented forms', () => {
  expect(parsePresentArgs(['index.html', '--project', 'creneau', '--title', 'UI'])).toEqual(
    { kind: 'open', entry: 'index.html', project: 'creneau', title: 'UI' },
  );
  expect(parsePresentArgs(['reset'])).toEqual({ kind: 'reset' });
  expect(parsePresentArgs(['reset', 'creneau'])).toEqual({ kind: 'reset', project: 'creneau' });
  expect(parsePresentArgs(['agent-install', 'codex'])).toEqual({ kind: 'agent-install', target: 'codex' });
  expect(() => parsePresentArgs(['agent-intsall'])).toThrow('Unknown present command');
});

test('installs a Claude skill in an injected home directory', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tether-skill-'));
  try {
    const file = installAgentSkill('claude', { home, hasCommand: () => true });
    expect(file).toBe(path.join(home, '.claude/skills/tether-present/SKILL.md'));
    expect(await Bun.file(file).text()).toContain('tether present reset');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/server/src/server/presentCli.test.ts`

Expected: FAIL because `./presentCli` is absent.

- [ ] **Step 3: Implement command parsing, skills, and routes**

```ts
export type PresentArgs =
  | { kind: 'open'; entry: string; project?: string; title?: string }
  | { kind: 'reset'; project?: string }
  | { kind: 'agent-install'; target?: 'codex' | 'claude' };

export function parsePresentArgs(argv: string[]): PresentArgs;
export async function runPresent(args: PresentArgs, deps: PresentDeps): Promise<void>;
export function installAgentSkill(target: 'codex' | 'claude', deps: InstallDeps): string;
```

Write Codex's skill to `$HOME/.agents/skills/tether-present/SKILL.md` and Claude's to `$HOME/.claude/skills/tether-present/SKILL.md`. Its instructions must say to generate a preview folder, invoke `tether present`, optionally set `--project`, and call `tether present reset <project>` after approval or abandonment. With no target, install every detected `codex`/`claude`; requested but unavailable targets fail.

Refactor `app.ts` to export `createApp(registry, controlToken)` and retain `app` from production singletons. Place `POST /control/presentations` and `POST /control/presentations/reset` before `/api/*`; require a timing-safe match on `X-Tether-Present-Control`. Add authenticated `GET /api/presentations` and `DELETE /api/presentations/:id`. Add `GET /preview/:token/*` that uses `resolvePresentationFile`, supports `.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.woff2`, and emits `Cache-Control: no-store`.

Initialize the token and registry once in `serve.ts` before `Bun.serve`; dispose the registry on shutdown. In `main.ts`, dispatch `present` with `process.argv.slice(3)` and list every documented form in `help()`.

- [ ] **Step 4: Add route assertions and run server tests**

Add `app.request()` tests: bad/missing control token is 401, valid control opens a preview, authenticated list has no host path, a capability serves CSS, traversal is 404, and authenticated delete removes its record.

Run: `bun test apps/server/src/server/presentations.test.ts apps/server/src/server/presentCli.test.ts apps/server/src/server/auth.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/presentCli.ts apps/server/src/server/presentCli.test.ts apps/server/src/server/app.ts apps/server/src/server/serve.ts apps/server/src/server/main.ts
git commit -m "feat: add agent preview commands"
```

### Task 3: Add client presentation state and renderers

**Files:**
- Create: `apps/mobile/src/presentations.ts`
- Create: `apps/mobile/src/presentations.test.ts`
- Create: `apps/mobile/src/workspace.ts`
- Create: `apps/mobile/src/workspace.test.ts`
- Create: `apps/mobile/src/PreviewScreen.web.tsx`
- Create: `apps/mobile/src/PreviewScreen.native.tsx`
- Create: `apps/mobile/src/previewScreen.test.ts`
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes Task 2's authenticated list/delete endpoints.
- Produces pure workspace entries and platform renderers for Task 4.

- [ ] **Step 1: Write failing client-state and renderer tests**

```ts
import { expect, test } from 'bun:test';
import { reconcileActiveWorkspace, workspaceItems } from './workspace';

const previews = [{ id: 'p1', title: 'Creneau UI', project: 'creneau', revision: 0, url: '/preview/token/index.html' }];

test('makes terminal and preview peer workspace entries', () => {
  expect(workspaceItems([{ id: 'term-1', status: 'running', last_output_at: null, name: 'fish' }], previews))
    .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'terminal:term-1' }), expect.objectContaining({ key: 'preview:p1' })]));
});

test('returns to the terminal when an active preview vanishes', () => {
  expect(reconcileActiveWorkspace('preview:p1', [], 'term-1')).toBe('terminal:term-1');
});

test('keeps iOS WebView bridge-free and web iframe sandboxed', async () => {
  expect(await Bun.file(new URL('./PreviewScreen.native.tsx', import.meta.url)).text()).toContain("from 'react-native-webview'");
  const web = await Bun.file(new URL('./PreviewScreen.web.tsx', import.meta.url)).text();
  expect(web).toContain('sandbox="allow-scripts allow-forms allow-modals"');
  expect(web).toContain('Retry');
  expect(web).not.toContain('postMessage');
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/mobile/src/presentations.test.ts apps/mobile/src/workspace.test.ts apps/mobile/src/previewScreen.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement fetch, workspace helpers, and renderers**

```ts
export interface Presentation { id: string; title: string; project: string; revision: number; url: string }
export async function fetchPresentations(base: string, password: string): Promise<Presentation[]>;
export type WorkspaceItem =
  | { key: `terminal:${string}`; kind: 'terminal'; id: string; label: string; session: DrawerSession }
  | { key: `preview:${string}`; kind: 'preview'; id: string; label: string; presentation: Presentation };
export function workspaceItems(sessions: DrawerSession[], previews: Presentation[]): WorkspaceItem[];
export function reconcileActiveWorkspace(active: string, previews: Presentation[], terminalId: string): string;
```

`fetchPresentations` calls `${httpBase}/api/presentations` with `authHeaders(password)` and throws on a non-OK response. Test its Authorization header with a stubbed global fetch.

Run `cd apps/mobile && npx expo install react-native-webview`. The native renderer must use `WebView source={{ uri }}` and `key={`${uri}:${revision}`}`; the web renderer must use that same key on an iframe with `sandbox="allow-scripts allow-forms allow-modals"`. Both expose only Retry and Close on load failure. Neither renderer uses `onMessage`, injected JavaScript, or Tether credentials.

- [ ] **Step 4: Run focused checks**

Run: `bun test apps/mobile/src/presentations.test.ts apps/mobile/src/workspace.test.ts apps/mobile/src/previewScreen.test.ts && bun --cwd apps/mobile run lint && bun --cwd apps/mobile run build:web && bunx --cwd apps/mobile expo export --platform ios`

Expected: PASS and both exports finish.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/presentations.ts apps/mobile/src/presentations.test.ts apps/mobile/src/workspace.ts apps/mobile/src/workspace.test.ts apps/mobile/src/PreviewScreen.web.tsx apps/mobile/src/PreviewScreen.native.tsx apps/mobile/src/previewScreen.test.ts apps/mobile/package.json bun.lock
git commit -m "feat(mobile): add preview renderer"
```

### Task 4: Integrate unified workspace navigation

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/DesktopSessionNavigator.tsx`
- Modify: `apps/mobile/src/SessionDrawer.tsx`
- Modify: `apps/mobile/src/desktopNavigation.test.ts`
- Modify: `apps/mobile/src/sessionDrawer.test.ts`

**Interfaces:**
- Consumes Task 3 `Presentation`, `WorkspaceItem`, `workspaceItems`, `reconcileActiveWorkspace`, `fetchPresentations`, and `PreviewScreen`.
- Produces the same terminal selection/kill behavior plus preview selection and close behavior.

- [ ] **Step 1: Write failing navigation assertions**

```ts
test('desktop navigator accepts workspace items and labels previews', async () => {
  const source = await Bun.file(new URL('./DesktopSessionNavigator.tsx', import.meta.url)).text();
  expect(source).toContain('items: WorkspaceItem[]');
  expect(source).toContain('Previews');
  expect(source).toContain('Preview ${item.label}');
});

test('mobile drawer keeps its top safe-area wrapper while accepting workspace items', async () => {
  const source = await Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text();
  expect(source).toContain("<SafeAreaView edges={['top']} style={styles.panelContent}>");
  expect(source).toContain('items: WorkspaceItem[]');
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/mobile/src/desktopNavigation.test.ts apps/mobile/src/sessionDrawer.test.ts`

Expected: FAIL because the navigators still accept only terminal sessions.

- [ ] **Step 3: Integrate polling and selection**

In `TerminalScreen.tsx`, add `previews` and `activeWorkspace` state. Poll `fetchPresentations(httpBase(serverIp, port), password)` every 1000ms only after `ready && password`; fetch once immediately and clear the interval on unmount. When a preview is removed, call `reconcileActiveWorkspace(activeWorkspace, previews, activeId)`. Selecting a terminal calls existing `switchTo(id)` and sets `terminal:${id}`; selecting a preview only sets `preview:${id}`, so the last terminal socket remains unchanged. Render the existing terminal main when active terminal, otherwise render `PreviewScreen` from Task 3. Close calls authenticated `DELETE /api/presentations/:id` and returns to `terminal:${activeId}`.

Change both navigator props to `items: WorkspaceItem[]`, `activeKey: string`, `onSelect(item: WorkspaceItem)`, and `onClosePreview(id: string)`. Retain terminal kill confirmation. Desktop sidebar/hover render **Terminals** and **Previews** labels; the tabs mode renders both as entries. Mobile drawer uses the same groups and leaves the current SafeAreaView and overlay behavior intact.

- [ ] **Step 4: Run UI and export checks**

Run: `bun test apps/mobile/src/workspace.test.ts apps/mobile/src/desktopNavigation.test.ts apps/mobile/src/sessionDrawer.test.ts apps/mobile/src/previewScreen.test.ts && bun --cwd apps/mobile run lint && bun --cwd apps/mobile run build:web && bunx --cwd apps/mobile expo export --platform ios && bun --cwd apps/mobile run tauri build --debug`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/TerminalScreen.tsx apps/mobile/src/DesktopSessionNavigator.tsx apps/mobile/src/SessionDrawer.tsx apps/mobile/src/desktopNavigation.test.ts apps/mobile/src/sessionDrawer.test.ts
git commit -m "feat(mobile): add preview workspace tabs"
```

### Task 5: Document and verify the complete workflow

**Files:**
- Modify: `docs/terminal/sessions.md`
- Modify: `docs/desktop.md`

**Interfaces:**
- Consumes the implemented command grammar and user-visible behavior from Tasks 1-4.

- [ ] **Step 1: Document the exact workflow**

Add this command block to `docs/terminal/sessions.md`:

```sh
tether present ./preview/index.html --project creneau --title "Creneau UI"
tether present reset creneau
tether present reset
tether present agent-install
tether present agent-install codex
```

State that previews serve only their directory, refresh when files change, are display-only, disappear when closed/restarted/reset, and render on desktop plus iOS. Add a desktop note that previews are workspace peers with terminal sessions and load inside an isolated frame.

- [ ] **Step 2: Run complete automated verification**

Run: `bun --cwd apps/server lint && (cd apps/server && bun test) && (cd apps/mobile && bun test) && bun --cwd apps/mobile run lint && bun --cwd apps/mobile run build:web && bunx --cwd apps/mobile expo export --platform ios && bun --cwd apps/mobile run tauri build --debug && bun run docs:build && git diff --check`

Expected: exit code 0.

- [ ] **Step 3: Perform manual acceptance**

1. Start Tether and create `preview/index.html`, `preview/style.css`, and `preview/app.js`.
2. Run `tether present ./preview/index.html --project creneau --title "Creneau UI"`.
3. On Tauri desktop and iPhone, confirm a **Creneau UI** preview appears under **Previews** and local CSS/JS render.
4. Edit `style.css`; confirm both views reload within two seconds.
5. Close it in one client; confirm it disappears in the other and no longer reloads.
6. Open two `creneau` previews; verify `tether present reset creneau` closes both. Reopen one and verify bare `reset` closes it.
7. Run `agent-install codex` and `agent-install claude`; verify each `tether-present/SKILL.md` exists and includes present/reset instructions.

- [ ] **Step 4: Commit**

```bash
git add docs/terminal/sessions.md docs/desktop.md
git commit -m "docs: explain agent HTML previews"
```
