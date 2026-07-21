# In-App Alert/Confirm Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `notify()`/`confirmAction()`'s desktop path (native `@tauri-apps/plugin-dialog` calls) with an in-app themed modal, avoiding an upstream `rfd`/GTK3 bug that makes GNOME show native dialogs as a second independent "Tether" window.

**Architecture:** A small module-level queue + subscribe function added to `dialog.ts` (no new file needed for the store — it's tightly coupled to the two functions already there). A new `AlertModal.tsx` component (mirrors `UpdateModal.tsx`'s exact themed card/backdrop structure) subscribes to the queue and renders the current pending alert. Mounted once in `TerminalScreen.tsx`, isDesktop-gated.

**Tech Stack:** TypeScript, React Native (`Modal`, existing `useAppTheme()`), Bun test runner (`bun:test`).

## Global Constraints

- `notify()`/`confirmAction()` keep their exact existing signatures — no call site among the ~15 across the app changes.
- Mobile's `Alert.alert` path is untouched — this is desktop-only.
- Only one alert renders at a time; a second call while one is showing queues and appears once the first resolves — nothing is silently dropped.
- No new npm/Cargo dependency.

---

### Task 1: Alert queue in `dialog.ts`

**Files:**
- Modify: `apps/mobile/src/dialog.ts` (full rewrite of the desktop branches)
- Test: `apps/mobile/src/dialog.test.ts` (new — no existing test file for this module)

**Interfaces:**
- Produces: `subscribeAlert(listener: (req: AlertRequest | null) => void): () => void` and the exported `AlertRequest` type (both consumed by Task 2's `AlertModal.tsx`):
  ```typescript
  export type AlertRequest =
    | { kind: 'notify'; title: string; body: string; level: 'info' | 'error'; resolve: () => void }
    | {
        kind: 'confirm';
        title: string;
        body: string;
        confirmLabel: string;
        destructive: boolean;
        resolve: (ok: boolean) => void;
      };
  ```
- Consumes: nothing new — `notify`/`confirmAction` keep consuming `Platform`/`Alert` from `react-native` exactly as today.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/dialog.test.ts`:

```typescript
import { expect, test } from 'bun:test';

// react-native-web's Platform.OS is hardcoded to 'web' (see
// apps/mobile/src/dialog.ts's isDesktop check) — this test environment already
// resolves 'react-native' to react-native-web, so no Platform mocking is needed
// to exercise dialog.ts's desktop branch.
const { notify, confirmAction, subscribeAlert } = await import('./dialog');

test('notify resolves once the rendered alert calls resolve()', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = notify('Title', 'Body', 'error');
  await Promise.resolve(); // let notify's Promise executor run and push

  expect(seen.length).toBe(1);
  const req = seen[0] as Extract<import('./dialog').AlertRequest, { kind: 'notify' }>;
  expect(req.kind).toBe('notify');
  expect(req.title).toBe('Title');
  expect(req.body).toBe('Body');
  expect(req.level).toBe('error');

  req.resolve();
  await expect(pending).resolves.toBeUndefined();
  unsub();
});

test('a second notify() while one is pending queues instead of replacing it', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const first = notify('First', 'Body');
  await Promise.resolve();
  const second = notify('Second', 'Body');
  await Promise.resolve();

  // Still showing the first one — the second hasn't been announced to the listener yet.
  const firstReq = seen[seen.length - 1] as Extract<import('./dialog').AlertRequest, { kind: 'notify' }>;
  expect(firstReq.title).toBe('First');

  firstReq.resolve();
  await Promise.resolve();
  await expect(first).resolves.toBeUndefined();

  const secondReq = seen[seen.length - 1] as Extract<import('./dialog').AlertRequest, { kind: 'notify' }>;
  expect(secondReq.title).toBe('Second');
  secondReq.resolve();
  await expect(second).resolves.toBeUndefined();
  unsub();
});

test('confirmAction resolves true when the confirm button fires', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = confirmAction('Kill session?', 'This cannot be undone.', {
    confirmLabel: 'Kill',
    destructive: true,
  });
  await Promise.resolve();

  const req = seen[seen.length - 1] as Extract<import('./dialog').AlertRequest, { kind: 'confirm' }>;
  expect(req.kind).toBe('confirm');
  expect(req.confirmLabel).toBe('Kill');
  expect(req.destructive).toBe(true);

  req.resolve(true);
  await expect(pending).resolves.toBe(true);
  unsub();
});

test('confirmAction resolves false when cancel fires', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = confirmAction('Kill session?', 'This cannot be undone.');
  await Promise.resolve();

  const req = seen[seen.length - 1] as Extract<import('./dialog').AlertRequest, { kind: 'confirm' }>;
  req.resolve(false);
  await expect(pending).resolves.toBe(false);
  unsub();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --cwd apps/mobile test src/dialog.test.ts`
Expected: FAIL — `subscribeAlert` doesn't exist yet, and `notify`/`confirmAction` still call the (unmocked) `@tauri-apps/plugin-dialog` import, which will throw or hang since that module doesn't resolve in the test environment.

- [ ] **Step 3: Rewrite `dialog.ts`**

Replace the full contents of `apps/mobile/src/dialog.ts`:

```typescript
// Cross-platform dialogs. On the Tauri desktop build, react-native-web's
// Alert.alert and window.confirm render as WebKitGTK's native *script* dialogs —
// titled "JavaScript – <origin>" (e.g. "tauri://localhost"), and confirm() can't
// show custom buttons. The native Tauri dialog plugin was tried instead, but
// rfd 0.16's GTK3 message-dialog backend hardcodes a null parent to
// gtk_message_dialog_new, so the dialog never gets a WM_TRANSIENT_FOR hint and
// GNOME shows it as a second independent "Tether" window/taskbar entry. The
// xdg-portal alternative was investigated and rejected: rfd has no real portal
// implementation for message dialogs at all, only file/save dialogs — it always
// shells out to zenity as a separate, unparented, arbitrarily-positioned
// process, which is worse. Desktop alerts are rendered in-app instead (see
// AlertModal.tsx) via the queue below. Mobile keeps the native styled Alert.
import { Platform, Alert } from 'react-native';

const isDesktop = Platform.OS === 'web';

export type AlertRequest =
  | { kind: 'notify'; title: string; body: string; level: 'info' | 'error'; resolve: () => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    };

// Only one alert renders at a time; anything queued behind it shows once the
// current one resolves — nothing is silently dropped, matching how native
// dialogs are effectively serial/blocking too.
const queue: AlertRequest[] = [];
let listener: ((req: AlertRequest | null) => void) | null = null;

function showNext() {
  listener?.(queue[0] ?? null);
}

// Called once by AlertModal on mount. Returns an unsubscribe function.
export function subscribeAlert(l: (req: AlertRequest | null) => void): () => void {
  listener = l;
  showNext();
  return () => {
    listener = null;
  };
}

function dequeueAndShowNext() {
  queue.shift();
  showNext();
}

// Informational dialog (single OK button).
export async function notify(
  title: string,
  body: string,
  kind: 'info' | 'error' = 'info',
): Promise<void> {
  if (isDesktop) {
    return new Promise<void>((resolve) => {
      queue.push({
        kind: 'notify',
        title,
        body,
        level: kind,
        resolve: () => {
          dequeueAndShowNext();
          resolve();
        },
      });
      if (queue.length === 1) showNext();
    });
  }
  Alert.alert(title, body);
}

// Cancel / confirm question. Resolves true only when the user confirms.
export async function confirmAction(
  title: string,
  body: string,
  opts: { confirmLabel?: string; destructive?: boolean } = {},
): Promise<boolean> {
  const { confirmLabel = 'OK', destructive = false } = opts;
  if (isDesktop) {
    return new Promise<boolean>((resolve) => {
      queue.push({
        kind: 'confirm',
        title,
        body,
        confirmLabel,
        destructive,
        resolve: (ok) => {
          dequeueAndShowNext();
          resolve(ok);
        },
      });
      if (queue.length === 1) showNext();
    });
  }
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun --cwd apps/mobile test src/dialog.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun --cwd apps/mobile test`
Expected: all prior tests still pass, plus the 4 new ones.

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/dialog.ts apps/mobile/src/dialog.test.ts
git commit -m "feat(desktop): queue-based alert store in dialog.ts, off native dialogs"
```

---

### Task 2: `AlertModal.tsx` component and mounting

**Files:**
- Create: `apps/mobile/src/AlertModal.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx:54` (import) and the `<UpdateModal .../>` render block (~line 534-544)

**Interfaces:**
- Consumes: `subscribeAlert`, `AlertRequest` from `./dialog` (Task 1); `useAppTheme()` from `./AppThemeProvider` (existing); `AppColors` type from `./appTheme` (existing, same as `UpdateModal.tsx` already imports).
- Produces: `AlertModal` component, no props — fully self-contained via the store subscription. Nothing later depends on new exports beyond the component itself.

- [ ] **Step 1: Write `AlertModal.tsx`**

There is no dedicated automated test for this component — this codebase has no existing test coverage for any Modal component (`UpdateModal`, `SessionModals`), and Task 1's store tests already cover the logic a render test would duplicate. Verification for this task is typecheck + full suite regression (Step 2) plus manual on-device verification (Step 3).

Create `apps/mobile/src/AlertModal.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { subscribeAlert, type AlertRequest } from './dialog';

// Desktop in-app replacement for native OS alert/confirm dialogs (see dialog.ts
// for why). Renders nothing when no alert is pending.
export function AlertModal() {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [req, setReq] = useState<AlertRequest | null>(null);

  useEffect(() => subscribeAlert(setReq), []);

  if (!req) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (req.kind === 'notify') req.resolve();
        else req.resolve(false);
      }}
    >
      <View style={styles.alertBackdrop}>
        <View style={styles.alertCard}>
          <Text style={styles.alertTitle}>{req.title}</Text>
          <Text style={styles.alertBody}>{req.body}</Text>

          {req.kind === 'notify' ? (
            <View style={styles.alertBtns}>
              <TouchableOpacity
                style={[styles.alertBtn, styles.alertBtnPrimary]}
                onPress={req.resolve}
              >
                <Text style={[styles.alertBtnText, styles.alertBtnTextPrimary]}>OK</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.alertBtns}>
              <TouchableOpacity style={styles.alertBtn} onPress={() => req.resolve(false)}>
                <Text style={styles.alertBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.alertBtn,
                  req.destructive ? styles.alertBtnDestructive : styles.alertBtnPrimary,
                ]}
                onPress={() => req.resolve(true)}
              >
                <Text
                  style={[
                    styles.alertBtnText,
                    req.destructive ? styles.alertBtnTextDestructive : styles.alertBtnTextPrimary,
                  ]}
                >
                  {req.confirmLabel}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    alertBackdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    alertCard: {
      width: 360,
      maxWidth: '90%',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: 20,
    },
    alertTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
    alertBody: { color: c.textMuted, fontSize: 13, marginTop: 8, lineHeight: 18 },
    alertBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
    alertBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
    alertBtnPrimary: { backgroundColor: c.accent },
    alertBtnDestructive: { backgroundColor: c.danger },
    alertBtnText: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
    alertBtnTextPrimary: { color: c.accentText },
    alertBtnTextDestructive: { color: c.accentText },
  });
}
```

- [ ] **Step 2: Wire it into `TerminalScreen.tsx`**

In `apps/mobile/src/TerminalScreen.tsx`, add the import right after the existing `UpdateModal` import (currently line 54):

```typescript
import { UpdateModal } from './UpdateModal';
import { AlertModal } from './AlertModal';
```

Then find the existing render block (currently around line 534-544):

```tsx
          {/* Desktop self-update modal */}
          {isDesktop && (
            <UpdateModal
              info={updateInfo}
              updating={updating}
              pct={upPct}
              label={upLabel}
              onDismiss={dismissUpdate}
              onUpdate={startUpdate}
              onDownload={downloadUpdate}
            />
          )}
```

and add right after it, before the closing `</KeyboardAvoidingView>`:

```tsx
          {isDesktop && <AlertModal />}
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `bun --cwd apps/mobile test`
Expected: all tests still pass (no new automated tests added in this task — see the note in Step 1).

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

- [ ] **Step 4: Manual on-device verification**

On the real desktop session used to find the original bug: run `bun run tauri:dev` from `apps/mobile` (remember `tauri dev` here serves a static export, not a live Metro bundle — run `bun run build:web` first and relaunch to pick up frontend changes, per this repo's actual dev workflow).

1. Trigger a `notify()` (e.g. `echo ftp://nope.invalid` in a session, then click the link with no modifier held, or Ctrl+click it — the `ftp://` scheme is outside the allowed opener scope, so it errors either way once clicked with Ctrl held). Confirm a themed in-app modal appears (not a native GTK dialog) with an "OK" button that dismisses it.
2. Trigger a `confirmAction()` (e.g. right-click a session tab and choose an action that asks for confirmation, or use the kill-session path). Confirm the in-app modal shows both "Cancel" and the confirm button, styled red/destructive when applicable, and that Cancel/Confirm resolve correctly (the underlying action only proceeds on Confirm).
3. Check GNOME's Alt-Tab / window list while a modal is showing: confirm there is still only one "Tether" entry — no second window appears.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/AlertModal.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(desktop): render notify()/confirmAction() as an in-app modal"
```
