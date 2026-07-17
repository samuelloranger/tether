# Event-driven Git Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a per-session Git `+added -removed` summary to every connected Tether client without polling, and syntax-highlight both Git diffs and regular file views.

**Architecture:** A small server watcher owns the current Git root for each active PTY session, debounces native filesystem events, and broadcasts only summary changes through the existing session WebSocket. The mobile client keeps a summary per live session, derives a tappable banner from it, and uses a shared native Prism renderer for read-only source and diff lines.

**Tech Stack:** Bun, Hono, `node:fs.watch`, Git CLI, Expo/React Native, `prism-react-renderer@2.4.1`, TypeScript, Bun test.

## Global Constraints

- Compare tracked staged and unstaged changes with `git diff HEAD --numstat`; do not include untracked files.
- No polling timer, agent hook, hook installer, editor WebView, custom lexer, staging, commit, discard, or arbitrary-ref UI.
- Watch both the worktree and its resolved Git directory; debounce by exactly 150 ms and suppress an unchanged summary.
- Every subscriber to the same terminal session receives the same initial and changed summary.
- Use `prism-react-renderer@2.4.1` only; unsupported paths remain selectable plain text.
- Preserve the 1 MiB response cap, text selection, and Catppuccin theme behavior. Regular files wrap at the viewport edge and measure the requested source line before scrolling; diffs retain horizontal scrolling.
- Measure and record the production web-export and iOS-export size deltas before shipping the syntax dependency.

---

## File Structure

- Create `apps/server/src/server/gitWatch.ts`: owns one native worktree/Git-dir watcher and emits a deduplicated `DiffSummary`.
- Create `apps/server/src/server/gitWatch.test.ts`: verifies debounce, deduplication, root replacement, and disposal with a temporary Git repository.
- Modify `apps/server/src/server/gitRoot.ts`: expose a nullable Git-root lookup and absolute Git-directory lookup for the watcher.
- Modify `apps/server/src/server/gitDiff.ts`: share the `DiffSummary` type and provide an empty summary constant used by watcher, PTY, and client protocol.
- Modify `apps/server/src/server/pty.ts`: own a watcher per live session, broadcast `diff` frames, and dispose watchers with the PTY lifecycle.
- Modify `apps/server/src/server/app.ts`: pass `diff` frames through the existing authenticated WebSocket handler.
- Modify `apps/mobile/src/sessionCache.ts`: store the last pushed summary for each cached terminal.
- Modify `apps/mobile/src/sessionCache.test.ts`: update cached-session fixtures for the required summary.
- Modify `apps/mobile/src/useTetherApp.tsx`: consume `diff` frames, replace the summary fetch with local state, and expose the active summary/banner controls.
- Create `apps/mobile/src/ChangeBanner.tsx` and `apps/mobile/src/changeBanner.test.ts`: render and test the compact `+N -M` action.
- Create `apps/mobile/src/codeHighlight.tsx` and `apps/mobile/src/codeHighlight.test.ts`: map paths to Prism languages and render reusable tokenized code lines.
- Modify `apps/mobile/src/FileViewer.tsx` and `apps/mobile/src/DiffView.tsx`: use the shared renderer.
- Modify `apps/mobile/src/TerminalScreen.tsx`: render the banner and retain current takeover/back behavior.
- Modify `apps/mobile/package.json` and `bun.lock`: add the pinned highlighter dependency.

## Interfaces

```ts
// apps/server/src/server/gitDiff.ts
export interface DiffSummary {
  files: Array<{ path: string; insertions: number; deletions: number }>;
}
export const EMPTY_DIFF_SUMMARY: DiffSummary = { files: [] };

// apps/server/src/server/gitWatch.ts
export class GitWatch {
  constructor(onChange: (summary: DiffSummary) => void, delayMs?: number);
  setRoot(root: string | null): void;
  dispose(): void;
}

// apps/server/src/server/pty.ts Subscriber frame extension
type SessionFrame =
  | { type: 'output'; chunk: string; id: number }
  | { type: 'exit'; exitCode?: number }
  | { type: 'diff'; summary: DiffSummary };

// apps/mobile/src/codeHighlight.tsx
export function languageForPath(path: string): string | null;
export function CodeHighlight(props: {
  code: string;
  path: string;
  lineKinds?: Array<'context' | 'add' | 'remove' | 'meta'>;
  onLineLayout?: (sourceLine: number, y: number) => void;
}): React.ReactNode;
```

### Task 1: Build the Git summary watcher

**Files:**
- Create: `apps/server/src/server/gitWatch.ts`
- Create: `apps/server/src/server/gitWatch.test.ts`
- Modify: `apps/server/src/server/gitRoot.ts`
- Modify: `apps/server/src/server/gitDiff.ts`
- Test: `apps/server/src/server/gitDiff.test.ts`

**Consumes:** `readDiffSummary(root)` and `GitDiffError` from `gitDiff.ts`.

**Produces:** `GitWatch.setRoot(root)` and `GitWatch.dispose()` for PTY lifecycle ownership.

- [ ] **Step 1: Write the failing watcher tests**

  Create `gitWatch.test.ts` with a temporary initialized repository. Assert that one saved edit emits `{ files: [{ path: 'main.ts', insertions: 1, deletions: 1 }] }`, that several filesystem events in a 150 ms burst emit once, that a second event with identical `--numstat` emits nothing, and that `dispose()` prevents later callbacks.

  ```ts
  test('debounces native worktree events and suppresses an identical summary', async () => {
    await withRepo(async (root) => {
      const seen: DiffSummary[] = [];
      const watch = new GitWatch((summary) => seen.push(summary), 150);
      watch.setRoot(root);
      writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual([{ files: [{ path: 'main.ts', insertions: 1, deletions: 1 }] }]);
      await Bun.sleep(250);
      expect(seen).toHaveLength(1);
      watch.dispose();
    });
  });
  ```

- [ ] **Step 2: Run the new test and verify it fails**

  Run: `bun --cwd apps/server test src/server/gitWatch.test.ts`

  Expected: FAIL because `./gitWatch` does not exist.

- [ ] **Step 3: Add strict Git location helpers and shared summary types**

  In `gitRoot.ts`, add `findGitRoot(cwd): string | null` and `resolveGitDir(root): string`, using `git -C <cwd> rev-parse --show-toplevel` and `git -C <root> rev-parse --absolute-git-dir`. Keep the existing fallback resolver for file routes unchanged. Move the following exact type from `gitDiff.ts` into its exported public shape:

  ```ts
  export interface DiffSummary {
    files: DiffFileStat[];
  }

  export const EMPTY_DIFF_SUMMARY: DiffSummary = { files: [] };
  ```

  Make `readDiffSummary` return `DiffSummary`.

- [ ] **Step 4: Implement the minimal watcher**

  Implement `GitWatch` with two `watch()` handles, one for `{ recursive: true }` on the root and one for the absolute Git directory. `setRoot` must close old handles, set `lastSummary` to `null`, publish `EMPTY_DIFF_SUMMARY` for `null`, and immediately calculate/publish a valid root's summary. Both watcher callbacks call one `schedule()` method that clears/restarts a 150 ms timer. The timer reads Git, compares `JSON.stringify(summary.files)` to the last result, and calls `onChange` only on change. Catch `GitDiffError` and publish `EMPTY_DIFF_SUMMARY`; never throw from an OS watch callback.

  ```ts
  private refresh = () => {
    const summary = this.root ? safeReadDiffSummary(this.root) : EMPTY_DIFF_SUMMARY;
    if (JSON.stringify(summary.files) === JSON.stringify(this.lastSummary?.files)) return;
    this.lastSummary = summary;
    this.onChange(summary);
  };
  ```

- [ ] **Step 5: Run focused server tests and commit**

  Run: `bun --cwd apps/server test src/server/gitDiff.test.ts src/server/gitWatch.test.ts`

  Expected: PASS with the existing Git diff tests plus watcher debounce/disposal coverage.

  ```bash
  git add apps/server/src/server/gitDiff.ts apps/server/src/server/gitDiff.test.ts apps/server/src/server/gitRoot.ts apps/server/src/server/gitWatch.ts apps/server/src/server/gitWatch.test.ts
  git commit -m "feat: watch git worktrees for changes"
  ```

### Task 2: Push summaries through the terminal session WebSocket

**Files:**
- Modify: `apps/server/src/server/pty.ts:124-166, 180-214, 451-485`
- Modify: `apps/server/src/server/app.ts:14-22, 264-362`
- Test: `apps/server/src/server/pty.liveCwd.test.ts`
- Test: `apps/server/src/server/gitDiff.api.test.ts`

**Consumes:** `GitWatch`, `findGitRoot`, `DiffSummary`, and `EMPTY_DIFF_SUMMARY` from Task 1.

**Produces:** authenticated terminal WebSocket `{"type":"diff","summary":...}` frames, including one initial frame after subscription.

- [ ] **Step 1: Write failing session-frame tests**

  Extend `pty.liveCwd.test.ts` with a fake subscriber and a temporary Git root. Feed OSC 7 output through the existing PTY chunk path, change `main.ts`, and wait for a `diff` frame. Add an assertion that a second subscriber receives the current summary as soon as it subscribes.

  ```ts
  expect(frames).toContainEqual({
    type: 'diff',
    summary: { files: [{ path: 'main.ts', insertions: 1, deletions: 1 }] },
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `bun --cwd apps/server test src/server/pty.liveCwd.test.ts`

  Expected: FAIL because `Subscriber` does not accept a `diff` frame.

- [ ] **Step 3: Extend PTY instance lifecycle**

  Replace the current inline subscriber payload with a `SessionFrame` union. Add `diffSummary: DiffSummary` and `gitWatch: GitWatch` to `SessionInstance`. Construct the watcher with `summary => { instance.diffSummary = summary; broadcast(id, { type: 'diff', summary }); }`. After `recordChunk(id, text)`, resolve `findGitRoot(getLiveCwd(id) ?? '')` and call `instance.gitWatch.setRoot(root)` only when the root differs from the watcher's current root. Dispose the watcher before deleting an instance in normal exit, unexpected holder close, and `killSession`.

- [ ] **Step 4: Send the initial state and forward it in Hono**

  In `subscribeToSession`, immediately invoke the callback after registering it:

  ```ts
  callback({ type: 'diff', summary: instance.diffSummary });
  ```

  In `app.ts`'s `onData`, add the exact forwarding branch:

  ```ts
  } else if (data.type === 'diff') {
    ws.send(JSON.stringify({ type: 'diff', summary: data.summary }));
  }
  ```

  Retain `GET /api/sessions/:id/diff/summary` for compatibility, but remove all client use of it in Task 3.

- [ ] **Step 5: Run server regression tests and commit**

  Run: `bun --cwd apps/server test src/server/pty.liveCwd.test.ts src/server/gitDiff.api.test.ts src/server/pty.shell.test.ts`

  Expected: PASS; each subscriber gets the same initial/change summary, while existing output, exit, and OSC 7 behavior remains green.

  ```bash
  git add apps/server/src/server/pty.ts apps/server/src/server/app.ts apps/server/src/server/pty.liveCwd.test.ts apps/server/src/server/gitDiff.api.test.ts
  git commit -m "feat: push session git summaries"
  ```

### Task 3: Store pushed summaries and render the change banner

**Files:**
- Modify: `apps/mobile/src/sessionCache.ts`
- Modify: `apps/mobile/src/sessionCache.test.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx:155-170, 340-370, 1322-1378, 1558-1560`
- Create: `apps/mobile/src/ChangeBanner.tsx`
- Create: `apps/mobile/src/changeBanner.test.ts`
- Modify: `apps/mobile/src/TerminalScreen.tsx:83-84, 160-163, 282-296, 410-413`
- Modify: `apps/mobile/src/diffModel.ts`
- Modify: `apps/mobile/src/diffModel.test.ts`

**Consumes:** the `diff` WebSocket frame from Task 2 and `DiffSummary`/`totalChanges` from `diffModel.ts`.

**Produces:** a current `changeSummary` for each cached session, a banner action, and an opened diff view that never fetches a summary.

- [ ] **Step 1: Write failing pure-model and banner tests**

  Add `changeLabel(summary)` to `diffModel.test.ts` and test its exact copy. Test the new banner's model-facing props by rendering a nonempty summary and asserting `+3 -2`; test that an empty summary produces no banner.

  ```ts
  expect(changeLabel({ files: [{ path: 'a.ts', insertions: 3, deletions: 2 }] })).toBe('+3 -2');
  expect(changeLabel({ files: [] })).toBeNull();
  ```

- [ ] **Step 2: Run mobile tests and verify they fail**

  Run: `bun --cwd apps/mobile test src/diffModel.test.ts src/changeBanner.test.ts`

  Expected: FAIL because `changeLabel` and `ChangeBanner` do not exist.

- [ ] **Step 3: Make the summary session-scoped**

  Add `diffSummary: DiffSummary` to `SessionEntry` and initialize it to `{ files: [] }` in `entryFor`. In `applyWsMessage`, before terminal-output handling, accept the new frame and store the complete summary in that entry:

  ```ts
  if (msg.type === 'diff' && Array.isArray(msg.summary?.files)) {
    ent.diffSummary = { files: msg.summary.files };
    if (id === activeIdRef.current) setGitSummaryVersion((n) => n + 1);
    return;
  }
  ```

  Derive `changeSummary` from `entryFor(activeId).diffSummary`; keep the existing fetch only for individual diff text. Replace `diffSummary: DiffSummary | null` as the takeover flag with `diffOpen: boolean`, so a zero-change session can still show the `No changes` view and the banner state cannot accidentally hide the terminal.

- [ ] **Step 4: Render the minimal banner and remove summary polling**

  Implement `ChangeBanner` as one `TouchableOpacity` with `accessibilityRole="button"`, accessibility label `View changes, +N -M`, and Catppuccin success/danger text. Render it next to the existing session-preview affordance only when `changeLabel(changeSummary)` is non-null. Make `openDiff` set `diffOpen` and clear selected diff text; it must not call `/diff/summary`. Keep `selectDiffFile`'s on-demand `/diff?path=` fetch unchanged.

- [ ] **Step 5: Run focused tests, typecheck, and commit**

  Run: `bun --cwd apps/mobile test src/diffModel.test.ts src/changeBanner.test.ts src/sessionCache.test.ts`

  Run: `bun --cwd apps/mobile lint`

  Expected: all focused tests pass and TypeScript reports no errors.

  ```bash
  git add apps/mobile/src/sessionCache.ts apps/mobile/src/sessionCache.test.ts apps/mobile/src/useTetherApp.tsx apps/mobile/src/ChangeBanner.tsx apps/mobile/src/changeBanner.test.ts apps/mobile/src/TerminalScreen.tsx apps/mobile/src/diffModel.ts apps/mobile/src/diffModel.test.ts
  git commit -m "feat: show pushed git change counts"
  ```

### Task 4: Add Prism renderer with a measured dependency gate

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Create: `apps/mobile/src/codeHighlight.tsx`
- Create: `apps/mobile/src/codeHighlight.test.ts`

**Consumes:** Catppuccin `AppTheme` colors and code paths from `FileView`/`DiffView`.

**Produces:** a selectable native renderer for the built-in Prism grammars and a plain-text fallback.

- [ ] **Step 1: Capture the baseline export sizes**

  Run the current production exports before changing dependencies:

  ```bash
  bun --cwd apps/mobile build:web
  du -sb apps/mobile/dist
  bun --cwd apps/mobile x expo export --platform ios
  du -sb apps/mobile/dist
  ```

  Save both byte counts in the task handoff note; do not modify source during this step.

- [ ] **Step 2: Write failing language-selection tests**

  Test the exact path mapping and fallback contract:

  ```ts
  expect(languageForPath('src/app.tsx')).toBe('tsx');
  expect(languageForPath('scripts/install.sh')).toBe('bash');
  expect(languageForPath('README.md')).toBe('markdown');
  expect(languageForPath('assets/blob.bin')).toBeNull();
  ```

- [ ] **Step 3: Run the test and verify it fails**

  Run: `bun --cwd apps/mobile test src/codeHighlight.test.ts`

  Expected: FAIL because `./codeHighlight` does not exist.

- [ ] **Step 4: Add and implement the pinned renderer**

  Run: `bun --cwd apps/mobile add prism-react-renderer@2.4.1`

  Implement `languageForPath` for `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.sh`, `.bash`, `.zsh`, `.html`, `.css`, `.md`, `.yaml`, `.yml`, and `.py`. `CodeHighlight` uses `Highlight` and the library's bundled grammars to produce nested selectable native `Text` spans. Build its Prism theme from the active Catppuccin colors; use the existing terminal foreground for unclassified tokens. For a null language, return one `<Text selectable>` with the original code unchanged.

- [ ] **Step 5: Measure after adding the dependency and verify**

  Run:

  ```bash
  bun --cwd apps/mobile test src/codeHighlight.test.ts
  bun --cwd apps/mobile lint
  bun --cwd apps/mobile build:web
  du -sb apps/mobile/dist
  bun --cwd apps/mobile x expo export --platform ios
  du -sb apps/mobile/dist
  ```

  Expected: tests/typecheck pass. Add the before/after byte counts and delta to the board task note. If the delta is disproportionate for a read-only viewer, stop before Task 5 and report the measurements for a user decision.

  ```bash
  git add apps/mobile/package.json bun.lock apps/mobile/src/codeHighlight.tsx apps/mobile/src/codeHighlight.test.ts
  git commit -m "feat: add native code highlighting"
  ```

### Task 5: Apply syntax highlighting to file and diff views

**Files:**
- Modify: `apps/mobile/src/FileViewer.tsx:1-42`
- Modify: `apps/mobile/src/DiffView.tsx:1-90`
- Modify: `apps/mobile/src/fileViewer.test.ts`
- Modify: `apps/mobile/src/diffModel.test.ts`

**Consumes:** `CodeHighlight`, `languageForPath`, existing `FileView.path`, selected diff path, and `displayDiff`.

**Produces:** syntax-colored regular files that wrap and still jump to the requested source line, plus horizontally scrollable unified diffs with semantic colors.

- [ ] **Step 1: Write failing renderer-input tests**

  Add pure helpers to `codeHighlight.tsx` and `fileView.ts` if required. Test that file rendering forwards the full path and original text, maps one original source line to one measured renderer row, and records the requested line as zero-based index `file.line - 1`. Test unified diff line kinds exactly:

  ```ts
  expect(diffLineKinds('+const answer = 43;\n-old\n@@ -1 +1 @@')).toEqual([
    'add',
    'remove',
    'meta',
  ]);
  ```

  Also assert that `+` and `-` prefixes are retained in rendered text rather than stripped from selectable content.

- [ ] **Step 2: Run the tests and verify they fail**

  Run: `bun --cwd apps/mobile test src/fileViewer.test.ts src/codeHighlight.test.ts`

  Expected: FAIL because `diffLineKinds` does not exist.

- [ ] **Step 3: Replace each single text block with the shared renderer**

  In `FileViewer`, remove the horizontal `ScrollView`. Render one selectable, wrapping `Text` row per original source line through `CodeHighlight`; pass `onLineLayout` to record each row's actual Y. Keep `pendingTargetLine = Math.max(0, (file.line ?? 1) - 1)` in a ref. When that row reports layout, call `scrollRef.current?.scrollTo({ y, animated: false })` and clear the pending target. Reset the pending target when `file.path`, `file.content`, or `file.line` changes. This intentionally renders every source line inside the existing 1 MiB cap; add a `// ponytail:` comment naming that ceiling and the upgrade path to a virtualized measured list if profiling shows jank.

  In `DiffView`, retain its nested horizontal `ScrollView` and pass `displayDiff(diffText ?? '', diffTruncated)` plus `selectedPath ?? ''` to `CodeHighlight`. Mark `diff --git`, `index`, `---`, `+++`, and `@@` lines as `meta`; preserve addition/deletion/context background or foreground treatment on the containing line and apply Prism token colors only to its source content.

- [ ] **Step 4: Run focused UI-model tests and typecheck**

  Run: `bun --cwd apps/mobile test src/fileViewer.test.ts src/diffModel.test.ts src/codeHighlight.test.ts`

  Run: `bun --cwd apps/mobile lint`

  Expected: all tests pass and TypeScript is clean; regular source wraps, a terminal link scrolls to its measured source row, diffs remain horizontally scrollable, and unsupported text remains selectable and unchanged.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/mobile/src/FileViewer.tsx apps/mobile/src/DiffView.tsx apps/mobile/src/fileViewer.test.ts apps/mobile/src/diffModel.test.ts apps/mobile/src/codeHighlight.tsx apps/mobile/src/codeHighlight.test.ts
  git commit -m "feat: highlight file and diff code"
  ```

### Task 6: End-to-end verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-17-event-driven-git-changes.md` only to check completed boxes and append measured size results.

**Consumes:** all server frames, mobile state, watcher tests, and syntax renderer from Tasks 1-5.

**Produces:** verified behavior and a recorded bundle-size decision.

- [ ] **Step 1: Run the full automated suite**

  Run: `bun --cwd apps/server test`

  Run: `bun --cwd apps/mobile test`

  Run: `bun run lint`

  Run: `git diff --check`

  Expected: all server/mobile tests pass, both TypeScript checks pass, and Git reports no whitespace errors.

- [ ] **Step 2: Perform the multi-client manual test**

  Start one server, connect two Tether clients to the same terminal session, `cd` to a temporary Git repository, and save a tracked file. Confirm both clients show the same `+N -M` banner within one watcher debounce, no polling request occurs, tapping either banner lists the changed file, and the diff shows green/red line treatment plus syntax colors. Open a long line through a terminal file link and confirm the regular file viewer wraps it at the viewport edge, scrolls to the measured requested source line, and keeps text selectable; confirm the diff remains horizontally scrollable.

- [ ] **Step 3: Verify lifecycle changes**

  In the same session, commit the change, confirm both banners disappear, `cd` to a second repository, edit there, confirm both banners switch to the new root, then kill the session and confirm no further watcher callback is logged after another file save.

- [ ] **Step 4: Record measurement and commit verification state**

  Append the exact before/after web and iOS export byte counts, the deltas, and manual-test result to this plan. Then commit only the completed plan metadata:

  ```bash
  git add docs/superpowers/plans/2026-07-17-event-driven-git-changes.md
  git commit -m "docs: verify event-driven git changes"
  ```
