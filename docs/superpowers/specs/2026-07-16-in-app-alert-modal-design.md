# In-app alert/confirm modal (replace native desktop dialogs)

## Goal

Replace `notify()`/`confirmAction()`'s desktop path — currently native OS dialogs via `@tauri-apps/plugin-dialog` — with an in-app React Native modal. The native path has a real, upstream bug: `rfd` 0.16's GTK3 message-dialog backend hardcodes a null parent to `gtk_message_dialog_new`, so the dialog never gets a `WM_TRANSIENT_FOR` hint and GNOME shows it as a second, independent "Tether" window in the taskbar/Alt-Tab. The `xdg-portal` alternative was investigated and rejected: `rfd` has no real portal implementation for message dialogs at all, only file/save dialogs — it always shells out to `zenity` as a separate, unparented, arbitrarily-positioned process, which is worse. Moving both `notify()` and `confirmAction()` in-app sidesteps the bug entirely on the platform where it's most visible (Linux/GNOME) while also unifying desktop's dialog look with the rest of the app's existing themed modals.

Mobile is untouched — `Alert.alert` stays exactly as-is.

## Design

### Store (`dialog.ts`)

`notify()`/`confirmAction()` keep their exact existing signatures and call sites (~15 across the app, all unchanged). Only the desktop branch's internals change: instead of importing `@tauri-apps/plugin-dialog`, it pushes into a small module-level queue and returns a `Promise` that resolves when the rendered modal's button is pressed.

```typescript
type AlertRequest =
  | { kind: 'notify'; title: string; body: string; level: 'info' | 'error'; resolve: () => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    };

const queue: AlertRequest[] = [];
let listener: ((req: AlertRequest | null) => void) | null = null;

function showNext() {
  listener?.(queue[0] ?? null);
}

// Called once by AlertModal on mount; returns an unsubscribe function.
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
```

`notify()`'s desktop branch becomes:

```typescript
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
```

`confirmAction()`'s desktop branch mirrors this with `kind: 'confirm'`, pushing `confirmLabel`/`destructive` through and resolving `boolean`.

Only one alert is ever rendered at a time (`queue[0]`); if a second `notify()`/`confirmAction()` fires while one is showing, it queues and appears once the current one resolves — matching native dialogs' effectively-serial, blocking behavior. Nothing is silently dropped.

### Component (`AlertModal.tsx`, new file)

Mirrors `UpdateModal.tsx`'s exact structure: `Modal transparent animationType="fade"` over a themed backdrop/card (`c.overlay` backdrop, `c.surface`/`c.border` card, same corner radius/padding). Subscribes to the store on mount:

```typescript
const [req, setReq] = useState<AlertRequest | null>(null);
useEffect(() => subscribeAlert(setReq), []);
if (!req) return null;
```

Renders `req.title` / `req.body`. For `kind === 'notify'`: single "OK" button calling `req.resolve()`. For `kind === 'confirm'`: "Cancel" button calling `req.resolve(false)` and a confirm button calling `req.resolve(true)`, styled with `c.danger` background/text when `req.destructive` is true (matching `confirmAction`'s existing `destructive` semantics on mobile's `Alert.alert`), `c.accent` otherwise (matching `UpdateModal`'s primary button).

### Mounting

Rendered once in `TerminalScreen.tsx`, isDesktop-gated, next to the existing `<UpdateModal .../>`:

```tsx
{isDesktop && <AlertModal />}
```

No props needed — it's fully self-contained via the store subscription.

## Error handling and testing

- The store itself has no failure modes to handle (pure in-memory queue, no I/O) — no `try`/`catch` needed anywhere in the new code.
- New `dialog.test.ts` (no existing test file for this module today) covering the store directly: `notify()` resolves once `subscribeAlert`'s listener-driven `resolve()` is invoked; a second `notify()` fired while the first is pending queues instead of replacing it, and shows only after the first resolves; `confirmAction()` resolves `true`/`false` correctly from each button.
- `AlertModal.tsx` itself gets no dedicated test — this codebase has no existing test coverage for any of its Modal components (`UpdateModal`, `SessionModals`), and a snapshot/render test of a themed Modal wouldn't catch real bugs the store test doesn't already cover.
- Manual verification: on the real desktop session used to find this bug, trigger a `notify()` (e.g. the `ftp://` link error) and a `confirmAction()` (e.g. killing a session), confirm both render as in-app themed modals with no second window appearing in GNOME's Alt-Tab/taskbar.
