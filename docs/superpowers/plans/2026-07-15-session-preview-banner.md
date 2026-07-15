# Session ↔ Preview Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link an agent HTML preview to the terminal session that created it, and surface that link as tappable banners on the mobile client in both directions.

**Architecture:** The server stamps each spawned session's shell with a `TETHER_SESSION_ID` env var; `tether present` inherits it and forwards it as `sessionId` on the preview record. The mobile client uses that field to scope the existing "auto-jump to a new preview" behavior to the session it belongs to, and to drive two small tappable banner components — one on a terminal screen pointing at its open preview, one on a preview pointing back at its terminal.

**Tech Stack:** Bun + TypeScript (server, `apps/server`), Expo React Native + TypeScript (mobile, `apps/mobile`), `bun:test`.

## Global Constraints

- Repo formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100 (`bun format` before committing).
- No test runner config beyond `bun test` — run it directly from `apps/server` or `apps/mobile`, no `npm test` script wrapper exists.
- This codebase's convention for testable client-side logic is to extract it into a small pure-function module (see `desktopFocusGuard.ts` + `desktopFocusGuard.test.ts`) rather than trying to unit-test React component internals directly — no `.tsx` file in this repo has a matching `.test.ts`.
- `Presentation.sessionId` is **optional** everywhere (server type, mobile type) — a preview can still be created without one (manual testing, or a future non-CLI caller), and JSON.stringify already drops `undefined` fields, so omission requires no extra plumbing.
- Spec: `docs/superpowers/specs/2026-07-15-session-preview-banner-design.md`. This plan implements that spec exactly — do not add scope beyond it (no desktop UI changes, no `--session` CLI flag, no multi-preview-per-session banner UI).

---

### Task 1: Stamp each session's shell with `TETHER_SESSION_ID`

**Files:**
- Modify: `apps/server/src/server/pty.ts` (add `sessionEnv` export near `withTermEnv`, use it in `doStartSession`)
- Test: `apps/server/src/server/pty.env.test.ts`

**Interfaces:**
- Produces: `export function sessionEnv(id: string, env: NodeJS.ProcessEnv, shellEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv` — later tasks don't call this directly, but it's the mechanism every downstream task depends on being correct.

- [ ] **Step 1: Write the failing test**

Add to the end of `apps/server/src/server/pty.env.test.ts` (before the final `console.log` line):

```ts
import { sessionEnv, withTermEnv } from './pty';
```

Update the existing import line at the top of the file from:

```ts
import { withTermEnv } from './pty';
```

to:

```ts
import { sessionEnv, withTermEnv } from './pty';
```

Then add before the final `console.log(...)` line:

```ts
eq(
  sessionEnv('term-1', {}, undefined).TETHER_SESSION_ID,
  'term-1',
  'stamps the session id so the agent/CLI running inside this shell can read it',
);
eq(
  sessionEnv('term-1', {}, { ZDOTDIR: '/x' }).ZDOTDIR,
  '/x',
  'still merges shell-specific env (e.g. zsh ZDOTDIR)',
);
eq(
  sessionEnv('term-1', { FOO: 'bar' }, undefined).FOO,
  'bar',
  'still preserves unrelated existing env vars via withTermEnv/scrubAgentEnv',
);
eq(
  sessionEnv('term-1', {}, undefined).TERM,
  'xterm-256color',
  'still applies withTermEnv (TERM/COLORTERM overrides)',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun run src/server/pty.env.test.ts`
Expected: FAIL — `sessionEnv` is not exported from `./pty`.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/server/pty.ts`, immediately after the existing `withTermEnv` function (the one that returns `{ ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }`), add:

```ts
// Every process running inside a session's shell — the agent, and anything it
// shells out to (e.g. `tether present`) — inherits this via normal fork/exec.
// It's how the server later links a preview back to the session that made it.
export function sessionEnv(
  id: string,
  env: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return { ...withTermEnv(scrubAgentEnv(env)), ...shellEnv, TETHER_SESSION_ID: id };
}
```

Then in `doStartSession`, find this line (currently the `env:` entry of the `spawn(holderCmd, holderArgs, {...})` call):

```ts
    env: { ...withTermEnv(scrubAgentEnv(process.env)), ...shellEnv },
```

Replace it with:

```ts
    env: sessionEnv(id, process.env, shellEnv),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun run src/server/pty.env.test.ts`
Expected: `N assertions passed` (existing 4 + new 4), no throw.

- [ ] **Step 5: Run full server suite and lint**

Run: `cd apps/server && bun test && bun lint`
Expected: all pass, no new type errors (there are two pre-existing, unrelated `typecheck` failures in `presentCli.ts`/`presentCli.test.ts` from before this plan — don't try to fix those, they're out of scope).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server/pty.ts apps/server/src/server/pty.env.test.ts
git commit -m "feat(server): stamp session shells with TETHER_SESSION_ID"
```

---

### Task 2: Add `sessionId` to the server-side `Presentation` record

**Files:**
- Modify: `apps/server/src/server/presentations.ts`
- Test: `apps/server/src/server/presentations.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Presentation.sessionId?: string`; `PresentationRegistry.create(input: { entry: string; project?: string; title?: string; sessionId?: string }): Presentation` — Task 3 calls `create` with this new field.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/server/presentations.test.ts`, after the `'registers an HTML preview without exposing its filesystem root'` test:

```ts
test('associates a preview with the session that created it, and allows none', () => {
  const root = tempDir('tether-preview-');
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');
    const registry = new PresentationRegistry(10);

    const withSession = registry.create({ entry, sessionId: 'term-2' });
    expect(withSession.sessionId).toBe('term-2');

    const withoutSession = registry.create({ entry });
    expect(withoutSession.sessionId).toBeUndefined();

    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/server/presentations.test.ts`
Expected: FAIL — `Property 'sessionId' does not exist` (TS) or `withSession.sessionId` is `undefined` when it should be `'term-2'`.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/server/presentations.ts`:

Change the `Presentation` interface:

```ts
export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}
```

Change `create`'s parameter type and body:

```ts
  create(input: { entry: string; project?: string; title?: string; sessionId?: string }): Presentation {
    const entry = realpathSync(input.entry);
    if (path.extname(entry).toLowerCase() !== '.html')
      throw new Error('preview entry must be an HTML file');
    const root = path.dirname(entry);
    const id = randomUUID();
    const token = randomBytes(24).toString('hex');
    const preview: InternalPresentation = {
      id,
      title: input.title || path.basename(entry, path.extname(entry)),
      project: input.project || path.basename(root),
      revision: 0,
      url: `/preview/${token}/${path.basename(entry)}`,
      sessionId: input.sessionId,
      root,
      token,
      watcher: undefined as unknown as FSWatcher,
      timer: null,
    };
    preview.watcher = watch(root, { recursive: true }, () => this.bump(preview));
    this.previews.set(id, preview);
    return this.public(preview);
  }
```

Change `public()` to include it:

```ts
  private public(preview: InternalPresentation): Presentation {
    return {
      id: preview.id,
      title: preview.title,
      project: preview.project,
      revision: preview.revision,
      url: preview.url,
      sessionId: preview.sessionId,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/server/presentations.test.ts`
Expected: all tests in the file pass (existing 5 + new 1 = 6).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/presentations.ts apps/server/src/server/presentations.test.ts
git commit -m "feat(server): add optional sessionId to Presentation records"
```

---

### Task 3: Pass `sessionId` through the `/control/presentations` route

**Files:**
- Modify: `apps/server/src/server/app.ts`
- Test: `apps/server/src/server/presentations.api.test.ts`

**Interfaces:**
- Consumes: `PresentationRegistry.create` from Task 2 (now accepts `sessionId?: string`).
- Produces: `POST /control/presentations` accepts an optional `sessionId` string field in its JSON body and echoes it back on the created `Presentation`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/server/presentations.api.test.ts`, after the existing test:

```ts
test('associates a preview with the sessionId it was opened with', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-session-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');

    const opened = await app.request('/control/presentations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ entry, project: 'sessioned', sessionId: 'term-3' }),
    });
    const preview = (await opened.json()) as { sessionId?: string };
    expect(preview.sessionId).toBe('term-3');

    await app.request('/control/presentations/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ project: 'sessioned' }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/server/presentations.api.test.ts`
Expected: FAIL — `preview.sessionId` is `undefined`, expected `'term-3'`.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/server/app.ts`, find the `app.post('/control/presentations', ...)` handler's `presentations.create({...})` call:

```ts
      presentations.create({
        entry: body.entry,
        project: typeof body.project === 'string' ? body.project : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
      }),
```

Replace with:

```ts
      presentations.create({
        entry: body.entry,
        project: typeof body.project === 'string' ? body.project : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/server/presentations.api.test.ts`
Expected: both tests in the file pass.

- [ ] **Step 5: Run full server suite**

Run: `cd apps/server && bun test`
Expected: all pass (18 tests: 15 existing + 1 from Task 1 + 1 from Task 2 + 1 from this task).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server/app.ts apps/server/src/server/presentations.api.test.ts
git commit -m "feat(server): accept sessionId on POST /control/presentations"
```

---

### Task 4: `tether present` forwards `TETHER_SESSION_ID`

**Files:**
- Modify: `apps/server/src/server/presentCli.ts`
- Test: `apps/server/src/server/presentCli.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (server-side `sessionId` acceptance from Task 3 is what makes this useful, but this task only changes what the CLI sends).
- Produces: `runPresent`'s POST body for `kind: 'open'` includes `sessionId: process.env.TETHER_SESSION_ID` (present when set, omitted via `JSON.stringify` dropping `undefined` when not).

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/server/presentCli.test.ts`, after the existing `'sends the local control token without using the mobile password'` test:

```ts
test('includes the session id from TETHER_SESSION_ID when present, omits it when absent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-control-'));
  const originalSessionId = process.env.TETHER_SESSION_ID;
  try {
    const tokenFile = path.join(root, 'token');
    await Bun.write(tokenFile, 'local-token');

    process.env.TETHER_SESSION_ID = 'term-4';
    let withSession: Request | undefined;
    await runPresent(
      { kind: 'open', entry: 'index.html' },
      {
        port: '8085',
        tokenFile,
        fetch: async (input, init) => {
          withSession = new Request(input, init);
          return new Response('{}');
        },
      },
    );
    expect(await withSession?.json()).toEqual({
      entry: path.resolve('index.html'),
      sessionId: 'term-4',
    });

    delete process.env.TETHER_SESSION_ID;
    let withoutSession: Request | undefined;
    await runPresent(
      { kind: 'open', entry: 'index.html' },
      {
        port: '8085',
        tokenFile,
        fetch: async (input, init) => {
          withoutSession = new Request(input, init);
          return new Response('{}');
        },
      },
    );
    expect(await withoutSession?.json()).toEqual({ entry: path.resolve('index.html') });
  } finally {
    if (originalSessionId === undefined) delete process.env.TETHER_SESSION_ID;
    else process.env.TETHER_SESSION_ID = originalSessionId;
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/server/presentCli.test.ts`
Expected: FAIL — the request body has no `sessionId` key even when `TETHER_SESSION_ID` is set.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/server/presentCli.ts`, find:

```ts
  const body =
    args.kind === 'reset'
      ? { project: args.project }
      : { entry: path.resolve(args.entry), project: args.project, title: args.title };
```

Replace with:

```ts
  const body =
    args.kind === 'reset'
      ? { project: args.project }
      : {
          entry: path.resolve(args.entry),
          project: args.project,
          title: args.title,
          sessionId: process.env.TETHER_SESSION_ID,
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/server/presentCli.test.ts`
Expected: all tests in the file pass.

- [ ] **Step 5: Run full server suite, lint**

Run: `cd apps/server && bun test && bun lint`
Expected: all pass. (The `typecheck` script has two pre-existing unrelated failures noted in Task 1 — ignore them; don't let them block this task, but confirm you haven't added any *new* ones by running `bun run typecheck` and diffing against the known two.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server/presentCli.ts apps/server/src/server/presentCli.test.ts
git commit -m "feat(server): forward TETHER_SESSION_ID as sessionId on tether present"
```

---

### Task 5: Mobile `Presentation` type + pure session-matching helpers

**Files:**
- Modify: `apps/mobile/src/presentations.ts`
- Test: `apps/mobile/src/presentations.test.ts`

**Interfaces:**
- Consumes: nothing from server tasks directly (this is the client-side mirror of the type from Task 2).
- Produces:
  - `Presentation.sessionId?: string`
  - `findSessionPreview(presentations: Presentation[], sessionId: string): Presentation | null` — Task 8 uses this for the "preview ready" banner.
  - `pickAutoSelectPreview(rows: Presentation[], seen: ReadonlySet<string>, activeId: string): Presentation | null` — Task 6 uses this to scope auto-jump.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `apps/mobile/src/presentations.test.ts` with:

```ts
import { expect, test } from 'bun:test';
import { findSessionPreview, pickAutoSelectPreview, previewUrl, type Presentation } from './presentations';

function preview(overrides: Partial<Presentation> = {}): Presentation {
  return {
    id: 'p1',
    title: 'Preview',
    project: 'demo',
    revision: 0,
    url: '/preview/x/index.html',
    ...overrides,
  };
}

test('builds a preview URL from the configured tether server', () => {
  expect(previewUrl('192.168.50.30', '8085', '/preview/capability/index.html')).toBe(
    'http://192.168.50.30:8085/preview/capability/index.html',
  );
});

test('findSessionPreview returns the most recently created preview owned by a session', () => {
  const rows = [
    preview({ id: 'p1', sessionId: 'term-1' }),
    preview({ id: 'p2', sessionId: 'term-2' }),
    preview({ id: 'p3', sessionId: 'term-1' }),
  ];
  expect(findSessionPreview(rows, 'term-1')?.id).toBe('p3');
  expect(findSessionPreview(rows, 'term-2')?.id).toBe('p2');
  expect(findSessionPreview(rows, 'term-9')).toBeNull();
});

test('pickAutoSelectPreview only returns a preview new to `seen` and owned by the active session', () => {
  const rows = [preview({ id: 'p1', sessionId: 'term-1' }), preview({ id: 'p2', sessionId: 'term-2' })];
  expect(pickAutoSelectPreview(rows, new Set(), 'term-1')?.id).toBe('p1');
  expect(pickAutoSelectPreview(rows, new Set(), 'term-2')?.id).toBe('p2');
  expect(pickAutoSelectPreview(rows, new Set(['p1']), 'term-1')).toBeNull();
  expect(pickAutoSelectPreview(rows, new Set(), 'term-3')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun test src/presentations.test.ts`
Expected: FAIL — `findSessionPreview`/`pickAutoSelectPreview` are not exported from `./presentations`.

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `apps/mobile/src/presentations.ts` with:

```ts
import { httpBase } from './address';

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}

export function previewUrl(serverIp: string, port: string, url: string): string {
  return new URL(url, httpBase(serverIp, port)).toString();
}

// The most recently created open preview owned by a given terminal session —
// drives the "preview ready" banner on that session's terminal screen.
export function findSessionPreview(
  presentations: Presentation[],
  sessionId: string,
): Presentation | null {
  let match: Presentation | null = null;
  for (const preview of presentations) {
    if (preview.sessionId === sessionId) match = preview;
  }
  return match;
}

// A preview auto-selects (forces navigation) only when it's both new to this
// client (`seen`) and owned by the session the client is currently looking
// at — otherwise every connected client would jump to every new preview
// regardless of which session created it.
export function pickAutoSelectPreview(
  rows: Presentation[],
  seen: ReadonlySet<string>,
  activeId: string,
): Presentation | null {
  return rows.find((preview) => !seen.has(preview.id) && preview.sessionId === activeId) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun test src/presentations.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Run full mobile suite and lint**

Run: `cd apps/mobile && bun test && bun lint`
Expected: all pass, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/presentations.ts apps/mobile/src/presentations.test.ts
git commit -m "feat(mobile): add sessionId to Presentation, session-matching helpers"
```

---

### Task 6: Scope auto-jump to the preview's owning session

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx:65` (import), `apps/mobile/src/useTetherApp.tsx` (`refreshPresentations`, around line 555)

**Interfaces:**
- Consumes: `pickAutoSelectPreview` from Task 5.
- Produces: no new exports — `refreshPresentations`'s existing behavior (already used by Task 8's callers) changes internally: it no longer force-navigates to every new preview, only to ones owned by `activeIdRef.current`.

- [ ] **Step 1: Update the import**

Find:

```ts
import type { Presentation } from './presentations';
```

Replace with:

```ts
import { pickAutoSelectPreview, type Presentation } from './presentations';
```

- [ ] **Step 2: Update `refreshPresentations`**

Find (inside `refreshPresentations`, after the "primed" early-return block):

```ts
      const newPreview = rows.find((preview) => !seenPresentationIds.current.has(preview.id));
      seenPresentationIds.current = new Set(rows.map((preview) => preview.id));
```

Replace with:

```ts
      const newPreview = pickAutoSelectPreview(rows, seenPresentationIds.current, activeIdRef.current);
      seenPresentationIds.current = new Set(rows.map((preview) => preview.id));
```

(The rest of the function — `setPresentations(rows)`, the `if (newPreview) setActivePresentationId(newPreview.id)` branch, and the disappeared-preview fallback — is unchanged; `newPreview` now already comes pre-scoped to the active session.)

- [ ] **Step 3: Typecheck and run the mobile suite**

Run: `cd apps/mobile && bun lint && bun test`
Expected: `tsc --noEmit` clean, all tests pass (this task adds no new test file — it's covered by Task 5's `pickAutoSelectPreview` unit tests plus the manual verification in Task 8).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "fix(mobile): only auto-jump to a new preview on its owning session"
```

---

### Task 7: `PresentationBanner` component

**Files:**
- Create: `apps/mobile/src/PresentationBanner.tsx`

**Interfaces:**
- Consumes: `useAppTheme` (from `./AppThemeProvider`), `AppColors` (from `./appTheme`) — same as `ConnectionBanner.tsx`, which this follows the pattern of.
- Produces: `export function PresentationBanner({ label, icon, onPress }: { label: string; icon: 'layout' | 'terminal'; onPress: () => void }): JSX.Element` — Task 8 renders this twice, once per direction.

No test file for this task: this repo has no `.tsx` component with a matching `.test.ts` (confirmed — `ConnectionBanner.tsx`, the closest analogue, has none either). It's a pure presentational component with no branching logic to unit-test; correctness is confirmed visually in Task 8's manual verification step.

- [ ] **Step 1: Create the component**

Write `apps/mobile/src/PresentationBanner.tsx`:

```tsx
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

// A standing, tappable link between a terminal session and its open preview —
// shown on the terminal screen pointing at the preview, and on the preview
// screen pointing back at the terminal, using the same layout either way.
export function PresentationBanner({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: 'layout' | 'terminal';
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <TouchableOpacity
      style={styles.presentationBanner}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={14} color={theme.colors.info} />
      <Text style={styles.presentationBannerText} numberOfLines={1}>
        {label}
      </Text>
      <Feather name="chevron-right" size={14} color={theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    presentationBanner: {
      backgroundColor: c.surfaceRaised,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingVertical: 6,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    presentationBannerText: {
      flex: 1,
      fontSize: 12,
      color: c.info,
      fontWeight: '600',
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/mobile && bun lint`
Expected: `tsc --noEmit` clean (this file isn't imported/used anywhere yet, so this just confirms it compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/PresentationBanner.tsx
git commit -m "feat(mobile): add PresentationBanner component"
```

---

### Task 8: Wire both banners into `TerminalScreen.tsx`

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx`

**Interfaces:**
- Consumes: `PresentationBanner` (Task 7), `findSessionPreview` (Task 5). `selectPresentation`, `selectTerminal`, `presentations`, `activePresentation`, `activeId`, `drawerSessions` are all already destructured from `app` in this file (no new destructuring needed).
- Produces: no new exports — this is the final wiring task.

- [ ] **Step 1: Add imports**

Find:

```ts
import { PresentationView } from './PresentationView';
import { previewUrl } from './presentations';
```

Replace with:

```ts
import { PresentationBanner } from './PresentationBanner';
import { PresentationView } from './PresentationView';
import { findSessionPreview, previewUrl } from './presentations';
```

- [ ] **Step 2: Compute the banner targets**

Find (right before `return (`):

```ts
  }, [activePresentation, setMenuOpen, setSelectionViewOpen]);

  return (
```

Replace with:

```ts
  }, [activePresentation, setMenuOpen, setSelectionViewOpen]);

  const sessionPreview = findSessionPreview(presentations, activeId);
  const backTarget = activePresentation?.sessionId ?? activeId;
  const backLabel = drawerSessions.find((s) => s.id === backTarget)?.name || backTarget;

  return (
```

- [ ] **Step 3: Render the two banners**

Find:

```tsx
          {activePresentation ? (
            <PresentationView
              preview={activePresentation}
              url={previewUrl(serverIp, port, activePresentation.url)}
            />
          ) : <>
          {/* Connection banner — names the real state; no safety overclaim. */}
          <ConnectionBanner
```

Replace with:

```tsx
          {activePresentation ? (
            <>
              {!isDesktop && (
                <PresentationBanner
                  label={`Back to ${backLabel}`}
                  icon="terminal"
                  onPress={() => selectTerminal(backTarget)}
                />
              )}
              <PresentationView
                preview={activePresentation}
                url={previewUrl(serverIp, port, activePresentation.url)}
              />
            </>
          ) : <>
          {!isDesktop && sessionPreview && (
            <PresentationBanner
              label={`Preview ready: ${sessionPreview.title}`}
              icon="layout"
              onPress={() => selectPresentation(sessionPreview.id)}
            />
          )}
          {/* Connection banner — names the real state; no safety overclaim. */}
          <ConnectionBanner
```

- [ ] **Step 4: Typecheck and run the mobile suite**

Run: `cd apps/mobile && bun lint && bun test`
Expected: `tsc --noEmit` clean, all tests pass (56 + 3 from Task 5 = 59).

- [ ] **Step 5: Manual verification**

This is a UI change with no component test harness in this repo — verify by hand, per the spec's Testing section:

1. Start the server: `bun dev:server` (or your usual dev flow).
2. Start the mobile app against it (`bun dev:mobile`, connect a client) and open two terminal sessions, A and B.
3. In session A's shell, run `tether present <some-entry.html> --title "Test preview"` (any small local HTML file works — the `--project`/`--title` flags are unchanged by this plan).
4. Confirm: the client currently viewing A jumps straight to the preview (unchanged behavior — same session).
5. Switch to session B. Confirm B's terminal screen shows no forced navigation and displays the "Preview ready: Test preview" banner is **not** shown on B (it's scoped to A only) — switch back to A and confirm the banner **is** shown there whenever the preview view isn't already active.
6. Tap the "Preview ready" banner on A → jumps to the preview. Confirm the "Back to <A's name or id>" banner appears above the preview.
7. Tap the "Back to..." banner → returns to terminal A.
8. Repeat steps 3–7 on a second, real device or the desktop Tauri build if convenient, to confirm no regressions in the desktop `DesktopSessionNavigator` path (which should render exactly as before — no banners, since `!isDesktop` gates both).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mobile): render session-preview banners on the terminal screen"
```

---

## Self-Review Notes

- **Spec coverage:** session→preview link (Tasks 1–4), auto-jump scoping (Task 6), banner UX both directions (Tasks 7–8), edge cases — multiple previews per session (Task 5's `findSessionPreview` picks the most recent, matching spec), killed-session fallback (Task 8's `backTarget = activePresentation?.sessionId ?? activeId` — `selectTerminal` already handles a since-killed session id by auto-starting a fresh one, per existing `switchTo`/`startSession` behavior, so no extra code needed), no-`sessionId` preview fallback (same expression naturally falls back to `activeId`) — all covered. Testing section of the spec is covered 1:1 by Tasks 1, 2, 3, 4, 5's test steps plus Task 8's manual verification.
- **Placeholder scan:** none found — every step has real code or an exact command.
- **Type consistency:** `sessionId?: string` is spelled identically in the server `Presentation` (Task 2), the mobile `Presentation` (Task 5), and every call site. `findSessionPreview`/`pickAutoSelectPreview` signatures are defined once in Task 5 and used with matching signatures in Tasks 6 and 8.
