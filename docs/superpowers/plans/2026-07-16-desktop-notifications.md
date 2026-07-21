# Desktop Native Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire a native OS notification on the Tether desktop app when a terminal bell rings or a command finishes (new shell prompt appears), but only while the window is unfocused.

**Architecture:** `terminal.ts` gains a `promptReturnCount` counter (mirrors the existing `bellCount` pattern), incremented when OSC 133;A (shell prompt start) fires. A new `desktopNotify.ts` wraps `@tauri-apps/plugin-notification` (permission check/request + send). `useTetherApp.tsx` tracks real OS window focus via `focus`/`blur` listeners, requests notification permission once at startup, and fires `notify()` when either counter advances while unfocused.

**Tech Stack:** Rust (`tauri-plugin-notification` v2), TypeScript (`@tauri-apps/plugin-notification`), Bun test runner (`bun:test` with `mock.module`, same pattern as `desktopUpdate.test.ts`).

## Global Constraints

- Desktop-only (`isDesktop` gated) — no behavior change on iOS/Android.
- Notification permission is requested eagerly, once, at app startup — not lazily on first trigger.
- Notify only when the window is unfocused (real OS focus, not just "not minimized" — the existing `visibilitychange` listener in `useTetherApp.tsx` only catches minimize/hide and is a different, pre-existing mechanism for a different purpose; do not reuse or modify it).
- Click-to-focus relies on OS default behavior only (macOS/Windows typically bring the app forward when its own notification is clicked; Linux varies by notification daemon and may not). No custom click-handler code — this is an explicit scope cut, not an oversight.
- No migration/versioning concerns — this is new, additive behavior with no prior state.

---

### Task 1: `promptReturnCount` in `terminal.ts`

**Files:**
- Modify: `apps/mobile/src/terminal.ts:196` (add field next to `bellCount`), `apps/mobile/src/terminal.ts:241` (reset alongside `bellCount`), `apps/mobile/src/terminal.ts:653-659` (increment in the OSC 133;A branch)
- Test: `apps/mobile/src/terminal.test.ts` (append after test 61, before the final `console.log`)

**Interfaces:**
- Produces: `promptReturnCount: number` — public field on `TerminalEmulator`, starts at 0, incremented once per OSC 133;A (shell prompt start) sequence.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`, right before the final `console.log(\`\n  ${pass} assertions passed\n\`);` line:

```typescript
// 62. promptReturnCount increments once per OSC 133;A (new shell prompt = previous command finished).
{
  const t = new TerminalEmulator(80, 24);
  eq(t.promptReturnCount, 0, 'promptReturnCount starts at 0');
  t.write(`${E}]133;A${E}\\`);
  eq(t.promptReturnCount, 1, 'promptReturnCount increments on OSC 133;A');
  t.write(`ls${E}]133;D;0${E}\\${E}]133;A${E}\\`);
  eq(t.promptReturnCount, 2, 'promptReturnCount increments once per new prompt, not per OSC 133 sequence');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun --cwd apps/mobile test src/terminal.test.ts`
Expected: FAIL — `promptReturnCount` doesn't exist on `TerminalEmulator` yet (TypeScript/runtime error reading `undefined`).

- [ ] **Step 3: Add the field, reset, and increment**

In `apps/mobile/src/terminal.ts`, next to `bellCount = 0;` (currently line 196):

```typescript
  bellCount = 0;

  // Monotonically increasing counter, incremented once per OSC 133;A (shell
  // prompt start). A new prompt means the previous command finished — used
  // by the desktop app to notify when a long-running command completes.
  promptReturnCount = 0;
```

In `reset()`, next to `this.bellCount = 0;` (currently line 241):

```typescript
    this.bellCount = 0;
    this.promptReturnCount = 0;
```

In `dispatchOsc`'s OSC 133 branch (currently lines 653-659):

```typescript
    } else if (ps === '133') {
      if (pt.startsWith('A')) {
        this.promptRows.add(this.screen[this.cy]);
        this.promptReturnCount++;
      } else if (pt.startsWith('D')) {
```

(only the `this.promptReturnCount++;` line is new — the rest of the branch is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun --cwd apps/mobile test src/terminal.test.ts`
Expected: PASS, assertion count includes test 62's 3 checks.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun --cwd apps/mobile test`
Expected: `73 pass` (70 existing + 3 new... note: test 62 is one `test`-block-equivalent numbered comment containing 3 `eq()` calls, consistent with this file's existing style — the file's own `pass` counter increases by 3; the `bun test` file-level count stays the same since `terminal.test.ts` is still one file).

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "feat(mobile): track promptReturnCount (OSC 133;A) alongside bellCount"
```

---

### Task 2: `desktopNotify.ts` module

**Files:**
- Create: `apps/mobile/src/desktopNotify.ts`
- Create: `apps/mobile/src/desktopNotify.test.ts`
- Modify: `apps/mobile/package.json` (add `@tauri-apps/plugin-notification` dependency)

**Interfaces:**
- Produces: `ensureNotificationPermission(): Promise<void>` (checks/requests OS notification permission once; safe to call more than once — subsequent calls are cheap no-ops once granted), `notify(title: string, body: string): Promise<void>` (sends a notification if permission was granted; silently no-ops otherwise).
- Consumes: nothing from Task 1 (independent).

- [ ] **Step 1: Add the dependency**

In `apps/mobile/package.json`, in `"dependencies"`, add a line alphabetically near the other `@tauri-apps/*` entries:

```json
    "@tauri-apps/plugin-notification": "^2",
```

Run: `cd apps/mobile && bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 2: Write the failing tests**

Create `apps/mobile/src/desktopNotify.test.ts`:

```typescript
import { expect, mock, test, beforeEach } from 'bun:test';

const isPermissionGranted = mock(() => Promise.resolve(false));
const requestPermission = mock(() => Promise.resolve('granted' as const));
const sendNotification = mock((_opts: { title: string; body: string }) => {});
mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));

const { ensureNotificationPermission, notify } = await import('./desktopNotify');

beforeEach(() => {
  isPermissionGranted.mockClear();
  requestPermission.mockClear();
  sendNotification.mockClear();
});

test('ensureNotificationPermission requests permission when not already granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => Promise.resolve('granted'));
  await ensureNotificationPermission();
  expect(requestPermission).toHaveBeenCalled();
});

test('ensureNotificationPermission does not re-request when already granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(true));
  await ensureNotificationPermission();
  expect(requestPermission).not.toHaveBeenCalled();
});

test('notify sends a notification once permission is granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(true));
  await ensureNotificationPermission();
  await notify('title', 'body');
  expect(sendNotification).toHaveBeenCalledWith({ title: 'title', body: 'body' });
});

test('notify no-ops when permission was denied', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => Promise.resolve('denied'));
  await ensureNotificationPermission();
  await notify('title', 'body');
  expect(sendNotification).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun --cwd apps/mobile test src/desktopNotify.test.ts`
Expected: FAIL — `./desktopNotify` doesn't exist yet.

- [ ] **Step 4: Write `desktopNotify.ts`**

Create `apps/mobile/src/desktopNotify.ts`:

```typescript
// Desktop native notifications via the Tauri notification plugin. No-op
// anywhere but the actual Tauri desktop runtime — callers gate on `isDesktop`
// before calling these (see useTetherApp.tsx).
let permissionGranted: boolean | null = null;

// Call once at app startup (eager, not lazy on first trigger — product
// decision). Safe to call again; a subsequent call after permission was
// granted is a cheap no-op (single isPermissionGranted() check).
export async function ensureNotificationPermission(): Promise<void> {
  const { isPermissionGranted, requestPermission } = await import(
    '@tauri-apps/plugin-notification'
  );
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const result = await requestPermission();
    permissionGranted = result === 'granted';
  }
}

export async function notify(title: string, body: string): Promise<void> {
  if (permissionGranted !== true) return;
  const { sendNotification } = await import('@tauri-apps/plugin-notification');
  sendNotification({ title, body });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun --cwd apps/mobile test src/desktopNotify.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun --cwd apps/mobile test`
Expected: all prior tests still pass, plus the 4 new ones.

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json bun.lock apps/mobile/src/desktopNotify.ts apps/mobile/src/desktopNotify.test.ts
git commit -m "feat(desktop): add desktopNotify.ts wrapping the Tauri notification plugin"
```

(`bun.lock` is at the repo root — this is a Bun workspace, not a per-app lockfile.)

---

### Task 3: Rust plugin registration

**Files:**
- Modify: `apps/mobile/src-tauri/Cargo.toml` (add `tauri-plugin-notification`)
- Modify: `apps/mobile/src-tauri/src/main.rs` (register the plugin)
- Modify: `apps/mobile/src-tauri/capabilities/default.json` (add `notification:default`)

**Interfaces:**
- Produces: the `@tauri-apps/plugin-notification` JS API (Task 2) becomes callable from the running desktop app — this task doesn't add any new Rust `#[tauri::command]`s, it only wires up the official plugin (which ships its own commands internally).
- Consumes: nothing from Tasks 1-2.

- [ ] **Step 1: Add the Cargo dependency**

In `apps/mobile/src-tauri/Cargo.toml`, in `[dependencies]`, add a line after `tauri-plugin-window-state = "2"`:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Register the plugin in `main.rs`**

In `apps/mobile/src-tauri/src/main.rs`, find:

```rust
        .plugin(tauri_plugin_window_state::Builder::default().build())
```

and add right after it:

```rust
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 3: Add the capability**

In `apps/mobile/src-tauri/capabilities/default.json`, add `"notification:default"` to the `"permissions"` array, e.g. right after `"dialog:default",`:

```json
    "dialog:default",
    "notification:default",
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/mobile/src-tauri && cargo check`
Expected: `Finished` with no errors.

- [ ] **Step 5: Verify a real OS notification actually fires in this environment**

This repo's Rust build has no test infrastructure (same as the `ws_connect` commands and the keyring commands added earlier — verification is manual). Before trusting this end-to-end, confirm a notification daemon is actually reachable, independent of Tauri:

```bash
which notify-send && notify-send "Tether test" "manual verification"
```

Expected: a real desktop notification appears (or, in a headless/CI environment with no notification daemon, this command errors/no-ops — if so, note that as an environment limitation, not a code bug, same as the display-server limitation noted for the native secret store's manual verification).

If a display and notification daemon are both available, also run the actual desktop app (`bun run tauri:dev` from `apps/mobile`) and confirm `ensureNotificationPermission()` doesn't throw at startup (check the webview console / Rust stdout for errors).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src-tauri/Cargo.toml apps/mobile/src-tauri/Cargo.lock apps/mobile/src-tauri/src/main.rs apps/mobile/src-tauri/capabilities/default.json
git commit -m "feat(desktop): register the Tauri notification plugin"
```

---

### Task 4: Wire the trigger into `useTetherApp.tsx`

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (add an import, a startup effect, and a trigger effect)

**Interfaces:**
- Consumes: `ensureNotificationPermission`, `notify` from `./desktopNotify` (Task 2); `promptReturnCount` from `TerminalEmulator` (Task 1); `isDesktop` from `./platform` (already imported at the top of this file).
- Produces: nothing new returned from the hook — this is intentionally self-contained inside `useTetherApp.tsx` (no UI component needs these values, unlike `activeBellCount`, which `TerminalScreen.tsx` reads for its haptic bell-flash). Do NOT add anything to the hook's giant return-object/destructuring list for this task.

- [ ] **Step 1: Add the import**

At the top of `apps/mobile/src/useTetherApp.tsx`, alongside the other same-directory imports (e.g. right after `import { pickAutoSelectPreview, type Presentation } from './presentations';`):

```typescript
import { ensureNotificationPermission, notify } from './desktopNotify';
```

- [ ] **Step 2: Add the startup permission-request effect**

Find the "Poll the session list and presentation metadata every 4s" `useEffect` block (the one with the `visibilitychange` listener). Add a new effect right after it (after its closing `}, [isConfiguring, serverIp, port]);`):

```typescript
  // Desktop: get notification permission out of the way at startup (eager,
  // not lazy on first trigger — product decision), independent of connection
  // state.
  useEffect(() => {
    if (isDesktop) void ensureNotificationPermission();
  }, []);
```

- [ ] **Step 3: Add the trigger effect**

Find this existing line (currently around line 1221):

```typescript
  const activeBellCount = entryFor(activeId).term.bellCount;
```

Add right after it:

```typescript
  const activeBellCount = entryFor(activeId).term.bellCount;
  // Read live off the mutable emulator field, same pattern as activeBellCount
  // above.
  const activePromptReturnCount = entryFor(activeId).term.promptReturnCount;

  // Desktop: native notification when a bell rings or a command finishes (new
  // shell prompt appears) while the window isn't focused. windowFocusedRef
  // tracks real OS focus — distinct from the visibilitychange listener
  // earlier in this file, which only catches minimize/hide, not "visible but
  // alt-tabbed away".
  const windowFocusedRef = useRef(true);
  useEffect(() => {
    if (!isDesktop || typeof window === 'undefined') return;
    const onFocus = () => {
      windowFocusedRef.current = true;
    };
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const prevBellCountForNotifyRef = useRef(0);
  const prevPromptReturnCountRef = useRef(0);
  useEffect(() => {
    if (!isDesktop) return;
    const bellFired = activeBellCount > prevBellCountForNotifyRef.current;
    const promptReturned = activePromptReturnCount > prevPromptReturnCountRef.current;
    prevBellCountForNotifyRef.current = activeBellCount;
    prevPromptReturnCountRef.current = activePromptReturnCount;
    if ((bellFired || promptReturned) && !windowFocusedRef.current) {
      void notify('Tether', bellFired ? 'Terminal bell' : 'Command finished');
    }
  }, [activeBellCount, activePromptReturnCount]);
```

(`prevBellCountForNotifyRef` is a separate ref from `TerminalScreen.tsx`'s own `prevBellCount` ref used for the haptic flash — they track the same underlying counter independently for two unrelated purposes in two different places, which is intentional, not duplication to clean up.)

- [ ] **Step 4: Typecheck and run the full suite**

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

Run: `bun --cwd apps/mobile test`
Expected: all tests still pass (this task adds no new automated tests — there is no existing test infrastructure for `useTetherApp.tsx` itself, same as every other addition to this hook this session).

- [ ] **Step 5: Manual verification**

If a display is available (see Task 3 Step 5's caveat if not): run `bun run tauri:dev` from `apps/mobile`, connect to a session, run a command in the remote shell that takes a few seconds (e.g. `sleep 3`), switch focus to a different app before it finishes, and confirm a native notification appears once the shell prompt returns. Separately, run `printf '\a'` in the remote shell while unfocused and confirm a bell notification appears.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "feat(desktop): notify on bell or command-finished while unfocused"
```
