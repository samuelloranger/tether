# `useTetherApp` Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `apps/mobile/src/useTetherApp.tsx` into domain-cohesive hooks under `apps/mobile/src/tether/` while keeping `useTetherApp()` as the sole public facade with an unchanged return shape for `App` and `TerminalScreen`.

**Architecture:** Extract leaf hooks first (no transport deps), then connection config, then pure session logic, then the sessions hook (sole socket/emulator owner), then input/presentations/desktop effects. The facade only composes hooks in dependency order and maps outputs to the existing public object. No React context, no global store, no new dependencies.

**Tech Stack:** Expo 57 / React Native 0.86 / React 19 (mobile), Bun test (`bun:test`), Biome formatting. Spec: `docs/superpowers/specs/2026-07-16-use-tether-app-decomposition-design.md`.

## Global Constraints

- `useTetherApp()` remains the only public hook; `App` / `TerminalScreen` must not import internal `tether/` hooks.
- `ReturnType<typeof useTetherApp>` and user-visible behaviour stay compatible throughout — no consumer redesign.
- `useTerminalSessions` is the only owner of sockets, `SessionCache`, emulators, reconnect, kill, and `send()` for the active session.
- Input / desktop / UI hooks never see a socket ref or create a connection.
- Live-tab cache cap stays at 3. No server protocol changes. No global state library.
- Formatting is Biome (2-space, single quotes, semicolons, trailing commas, width 100) — run `bun format` before committing.
- Prefer extracting pure helpers + Bun tests over adding a hook-test framework.
- Features not named in the design (git/diff UI, file viewer, upload, deep links) may remain in the facade as composition glue; do not invent new domains for them in this plan.

---

## File structure (target)

| File | Responsibility |
|---|---|
| `apps/mobile/src/tether/types.ts` | Shared domain types only (`ConnectionStatus`, `TerminalConnectionState`, …) |
| `apps/mobile/src/tether/useAppPreferences.ts` | Snippets + sidebar pin persistence |
| `apps/mobile/src/tether/useTerminalUiState.ts` | Screen-local modal/drawer/search/selection visibility |
| `apps/mobile/src/tether/useDesktopUpdater.ts` | Desktop update check/download/install (no-op path on mobile) |
| `apps/mobile/src/tether/useTerminalViewport.ts` | Font size/family, mouse + notification prefs |
| `apps/mobile/src/tether/useConnectionConfig.ts` | Host/port/password, pairing, save/edit, authenticated HTTP client |
| `apps/mobile/src/tether/terminalSessionLogic.ts` | Pure session/transport helpers (keys, switch, reconnect, WS message apply) |
| `apps/mobile/src/tether/useTerminalSessions.ts` | Sole `SessionCache` + per-session WS + emulator authority |
| `apps/mobile/src/tether/useTerminalInput.ts` | Ctrl, backspace streak, paste, key → `send()` |
| `apps/mobile/src/tether/usePresentations.ts` | Preview poll, seen-ids, auto-select, close |
| `apps/mobile/src/tether/useDesktopEffects.ts` | Desktop DOM keyboard/wheel/context/focus/drop bindings |
| `apps/mobile/src/useTetherApp.tsx` | Composition facade only (+ out-of-scope feature glue) |

Dependency order:

```text
config + preferences -> viewport -> sessions -> input + desktop effects
config -------------------------------> presentations
```

---

### Task 1: Shared types module

**Files:**
- Create: `apps/mobile/src/tether/types.ts`
- Modify: none yet (later tasks import from here)

**Interfaces:**
- Produces: `ConnectionStatus`, `TerminalConnectionState` (and any session-facing types the monolith already uses for socket state)

- [ ] **Step 1: Create the types module**

```typescript
import type { TerminalSocket } from '../wsTransport';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

export interface TerminalConnectionState {
  sock: TerminalSocket | null;
  gen: number;
  open: boolean;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  retry: number;
  ping: ReturnType<typeof setInterval> | null;
  lastSeen: number;
  /** Timestamp of the last onOpen; 0 when never opened. Gates the retry reset. */
  openedAt: number;
}
```

If the monolith already keys connections by host (multi-host), add a `client` field later in Task 6/8 — do not invent multi-host here unless the monolith already has it.

- [ ] **Step 2: Typecheck that the new file is clean**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS (or only pre-existing errors unrelated to `tether/types.ts`).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/tether/types.ts
git commit -m "refactor(mobile): add tether shared connection types"
```

---

### Task 2: Extract `useAppPreferences`

**Files:**
- Create: `apps/mobile/src/tether/useAppPreferences.ts`
- Create: `apps/mobile/src/tether/useAppPreferences.test.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx` (replace inline snippets/sidebar persistence with the hook)

**Interfaces:**
- Consumes: AsyncStorage keys already used in the monolith (`tether_snippets`, and sidebar pin key if present)
- Produces: `parseSnippets`, `parseSidebarPinned`, `useAppPreferences()` → `{ snippets, setSnippets, persistSnippets, sidebarPinned?, persistSidebarPinned? }`

- [ ] **Step 1: Write the failing pure-helper tests**

```typescript
import { expect, test } from 'bun:test';
import { parseSidebarPinned, parseSnippets } from './useAppPreferences';

test('parseSnippets keeps only stored string snippets', () => {
  expect(parseSnippets('["git status", 12, null, "npm test"]')).toEqual(['git status', 'npm test']);
});

test('parseSnippets falls back safely for malformed storage', () => {
  expect(parseSnippets('{not json')).toEqual([]);
  expect(parseSnippets('{"snippet":"git status"}')).toEqual([]);
});

test('parseSidebarPinned accepts only the string true', () => {
  expect(parseSidebarPinned('true')).toBe(true);
  expect(parseSidebarPinned('false')).toBe(false);
  expect(parseSidebarPinned(null)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd apps/mobile test src/tether/useAppPreferences.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement the module by moving code from the facade**

Move snippet load/persist (and sidebar pin if present) out of `useTetherApp` into:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const KEY_SNIPPETS = 'tether_snippets';
const KEY_SIDEBAR_PINNED = 'tether_sidebar_pinned';

export function parseSnippets(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((snippet): snippet is string => typeof snippet === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseSidebarPinned(value: string | null): boolean {
  return value === 'true';
}

export function useAppPreferences() {
  const [snippets, setSnippets] = useState<string[]>([]);
  const [sidebarPinned, setSidebarPinned] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS)
      .then((value) => setSnippets(parseSnippets(value)))
      .catch(() => {});
    AsyncStorage.getItem(KEY_SIDEBAR_PINNED)
      .then((value) => setSidebarPinned(parseSidebarPinned(value)))
      .catch(() => {});
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next)).catch(() => {});
  };

  const persistSidebarPinned = (next: boolean) => {
    setSidebarPinned(next);
    AsyncStorage.setItem(KEY_SIDEBAR_PINNED, next ? 'true' : 'false').catch(() => {});
  };

  return { snippets, setSnippets, persistSnippets, sidebarPinned, persistSidebarPinned };
}
```

Wire the facade: `const { snippets, setSnippets, persistSnippets, sidebarPinned, persistSidebarPinned } = useAppPreferences();` and delete the duplicated state/effects.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --cwd apps/mobile test src/tether/useAppPreferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/tether/useAppPreferences.ts apps/mobile/src/tether/useAppPreferences.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useAppPreferences from useTetherApp"
```

---

### Task 3: Extract `useTerminalUiState`

**Files:**
- Create: `apps/mobile/src/tether/useTerminalUiState.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Produces: view-only setters for drawer/menu/search/selection/rename/appearance/snippets-editor/context-menu. No persistence, no sockets.

- [ ] **Step 1: Create the hook by moving UI state**

```typescript
import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';

export function useTerminalUiState() {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [utilityPage, setUtilityPage] = useState(0);
  const [selectionViewOpen, setSelectionViewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [appearanceModalOpen, setAppearanceModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput | null>(null);
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetDraft, setSnippetDraft] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  return {
    ctxMenu,
    setCtxMenu,
    utilityPage,
    setUtilityPage,
    selectionViewOpen,
    setSelectionViewOpen,
    menuOpen,
    setMenuOpen,
    renameModalOpen,
    setRenameModalOpen,
    renameText,
    setRenameText,
    appearanceModalOpen,
    setAppearanceModalOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    snippetsModalOpen,
    setSnippetsModalOpen,
    snippetDraft,
    setSnippetDraft,
    drawerOpen,
    setDrawerOpen,
  };
}
```

Replace the matching `useState`/`useRef` block in `useTetherApp` with a single `useTerminalUiState()` call. Keep add/remove/send snippet helpers in the facade (they bridge preferences + input).

- [ ] **Step 2: Typecheck**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS for the moved symbols (facade still compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/tether/useTerminalUiState.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useTerminalUiState from useTetherApp"
```

---

### Task 4: Extract `useDesktopUpdater`

**Files:**
- Create: `apps/mobile/src/tether/useDesktopUpdater.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: `../desktopUpdate` (`fetchUpdate`, `installUpdate`, `openReleasesPage`, `PendingUpdate`), `../dialog.notify`, `../platform.isDesktop`
- Produces: `{ updateInfo, pendingUpdate, updateProgress, updating, disposePending, checkForUpdatesManual, startUpdate, downloadUpdate, dismissUpdate, … }`

- [ ] **Step 1: Move updater state + effects into the hook**

Cut the desktop update `useState`/`useRef`/`useEffect` and the check/start/download/dismiss helpers from `useTetherApp` into `useDesktopUpdater`. Early-return the mount effect with `if (!isDesktop) return;` so mobile registers nothing.

Skeleton return shape the facade already expects:

```typescript
return {
  updateInfo,
  setUpdateInfo,
  pendingUpdate,
  updateProgress,
  setUpdateProgress,
  updating,
  setUpdating,
  disposePending,
  checkForUpdatesManual,
  startUpdate,
  downloadUpdate,
  dismissUpdate,
};
```

- [ ] **Step 2: Wire the facade**

```typescript
const {
  updateInfo,
  setUpdateInfo,
  pendingUpdate,
  updateProgress,
  setUpdateProgress,
  updating,
  setUpdating,
  disposePending,
  checkForUpdatesManual,
  startUpdate,
  downloadUpdate,
  dismissUpdate,
} = useDesktopUpdater();
```

- [ ] **Step 3: Typecheck**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/useDesktopUpdater.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useDesktopUpdater from useTetherApp"
```

---

### Task 5: Extract `useTerminalViewport`

**Files:**
- Create: `apps/mobile/src/tether/useTerminalViewport.ts`
- Create: `apps/mobile/src/tether/useTerminalViewport.test.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Produces: `clampFontSize`, `useTerminalViewport()` → font size/family, lineHeight, mouse + notification toggles/refs (no socket knowledge)

- [ ] **Step 1: Write the failing clamp test**

```typescript
import { expect, test } from 'bun:test';
import { clampFontSize } from './useTerminalViewport';

test('clampFontSize keeps terminal fonts within the supported range', () => {
  expect(clampFontSize(7)).toBe(8);
  expect(clampFontSize(11)).toBe(11);
  expect(clampFontSize(25)).toBe(24);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/mobile test src/tether/useTerminalViewport.test.ts`
Expected: FAIL — module/export missing.

- [ ] **Step 3: Implement by moving font/mouse/notification prefs**

```typescript
export function clampFontSize(size: number): number {
  return Math.min(24, Math.max(8, size));
}

export function useTerminalViewport() {
  // Move: fontSize/fontFamily state, AsyncStorage load/persist for
  // tether_font_size / tether_mono_font / tether_mouse_enabled /
  // tether_notifications_enabled, changeFontSize/changeFontFamily,
  // toggleMouseEnabled/toggleNotificationsEnabled, mouseEnabledRef,
  // notificationsEnabledRef, testNotification.
  // Do NOT move window measurement or socket resize — those stay with sessions
  // or the facade until sessions owns dims.
}
```

Wire the facade to destructure the hook and delete the duplicated state/effects.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/mobile test src/tether/useTerminalViewport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/tether/useTerminalViewport.ts apps/mobile/src/tether/useTerminalViewport.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useTerminalViewport from useTetherApp"
```

---

### Task 6: Extract `useConnectionConfig`

**Files:**
- Create: `apps/mobile/src/tether/useConnectionConfig.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Produces: connection form state, `ready` / `isConfiguring`, authenticated HTTP helper (or host client), `testConnection`, `saveConfig` returning `{ addressChanged, wasReady }` so the facade can call sessions `resetForEndpointChange` when needed
- Does not own sockets

- [ ] **Step 1: Move connection form + pairing + HTTP helper**

Cut from `useTetherApp` into `useConnectionConfig`:

- host/port/password state + refs
- setup mode / confirm password / test status
- ready / isConfiguring
- load-from-storage effect
- `testConnection`, `saveConfig`
- the authenticated `request`/`client` helper used by presentations and sessions

Keep the facade orchestration that reacts to save:

```typescript
const saveConfig = async () => {
  const { addressChanged, wasReady } = await saveConnectionConfig();
  if (addressChanged && wasReady) resetForEndpointChange();
};
```

(`resetForEndpointChange` may still live in the facade until Task 8 moves it into sessions.)

- [ ] **Step 2: Typecheck**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 3: Smoke the public return shape**

Confirm `useTetherApp` still returns the same connection fields (`serverIp`, `port`, `password`, `testStatus`, `isConfiguring`, `testConnection`, `saveConfig`, …). Grep `App.tsx` / `TerminalScreen.tsx` / `ConfigScreen` usages if unsure.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/useConnectionConfig.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useConnectionConfig from useTetherApp"
```

---

### Task 7: Extract pure session transport logic

**Files:**
- Create: `apps/mobile/src/tether/terminalSessionLogic.ts`
- Create: `apps/mobile/src/tether/useTerminalSessions.test.ts` (tests for pure helpers; name matches later hook ownership)
- Modify: none yet (Task 8 will call these)

**Interfaces:**
- Produces: `sessionKey` / `parseSessionKey` (if multi-host keys already exist), `sessionSwitchAction`, `statusAfterClose`, `focusFrame`, `backoffDelay`, `retryAfterClose`, `scheduleReconnect`, `createSessionCache`, `applyWsMessage`, `maybeNotify`

- [ ] **Step 1: Write failing tests for switch / close / reconnect rules**

```typescript
import { describe, expect, test } from 'bun:test';
import {
  backoffDelay,
  focusFrame,
  retryAfterClose,
  sessionSwitchAction,
  statusAfterClose,
} from './terminalSessionLogic';

describe('sessionSwitchAction', () => {
  test('same key is a no-op', () => {
    expect(sessionSwitchAction('h:a', 'h:a', true)).toBe('none');
  });
  test('resident target hydrates without reconnect', () => {
    expect(sessionSwitchAction('h:a', 'h:b', true)).toBe('hydrate');
  });
  test('non-resident target connects', () => {
    expect(sessionSwitchAction('h:a', 'h:b', false)).toBe('connect');
  });
});

describe('statusAfterClose', () => {
  test('only the active connection flips the titlebar status', () => {
    expect(statusAfterClose('h:a', 'h:a', 'connected')).toBe('disconnected');
    expect(statusAfterClose('h:a', 'h:b', 'connected')).toBe('connected');
  });
});

describe('focusFrame', () => {
  test('builds the focus wire frame', () => {
    expect(focusFrame(true)).toEqual({ type: 'focus', focused: true });
  });
});

describe('backoffDelay', () => {
  test('grows monotonically through the capped retry window', () => {
    const delays = Array.from({ length: 10 }, (_, attempt) => backoffDelay(attempt, () => 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000]);
  });
});

describe('retryAfterClose', () => {
  test('resets retry after a healthy open window', () => {
    const now = 100_000;
    expect(retryAfterClose({ retry: 4, openedAt: now - 15_000 }, now)).toBe(0);
    expect(retryAfterClose({ retry: 4, openedAt: now - 200 }, now)).toBe(4);
  });
});
```

Adjust expected backoff numbers to match whatever formula the monolith already uses — do not invent a new retry curve.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd apps/mobile test src/tether/useTerminalSessions.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement pure helpers by lifting logic from the monolith**

Extract without behaviour change:

```typescript
export function sessionSwitchAction(
  activeKey: string,
  targetKey: string,
  targetIsResident: boolean,
): 'none' | 'hydrate' | 'connect' {
  if (targetKey === activeKey) return 'none';
  return targetIsResident ? 'hydrate' : 'connect';
}

export function statusAfterClose(
  activeKey: string,
  closedKey: string,
  current: ConnectionStatus,
): ConnectionStatus {
  return activeKey === closedKey ? 'disconnected' : current;
}

export function focusFrame(focused: boolean): { type: 'focus'; focused: boolean } {
  return { type: 'focus', focused };
}
```

Also move: reconnect scheduling, generation guards, WS message apply (output → emulator, title/activity/diff side effects as pure callbacks), notification edge detection. Keep React out of this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --cwd apps/mobile test src/tether/useTerminalSessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/tether/terminalSessionLogic.ts apps/mobile/src/tether/useTerminalSessions.test.ts
git commit -m "refactor(mobile): extract pure terminal session transport logic"
```

---

### Task 8: Extract `useTerminalSessions`

**Files:**
- Create: `apps/mobile/src/tether/useTerminalSessions.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Test: `apps/mobile/src/tether/useTerminalSessions.test.ts` (extend with any new pure helpers pulled during the move)

**Interfaces:**
- Consumes: connection `ready` / `isConfiguring` / authenticated client, viewport `fontFamily` / `fontSize` / `notificationsEnabledRef`, callbacks `onClearView` / `onClearPresentation` / `onCloseDrawer`
- Produces: active session identity, drawer sessions, connection status (active only), `terminalViewRef`, `entryFor`, `wsSend`/`send`, switch/new/kill/refresh, `resetForEndpointChange`, renderer hydration/resize/selection handlers, focus helpers

- [ ] **Step 1: Create the hook shell and move ownership piecemeal**

Move in this order (each sub-move should leave the app compiling):

1. `SessionCache` construction + `Map` of per-session connection state
2. `connect` / `disconnect` / reconnect-on-close (use Task 7 helpers)
3. WS message dispatch → `applyWsMessage`
4. Active-session React status + screen update scheduling (background sessions update emulators only)
5. `switchTo` / `newTerminal` / `kill` / LRU eviction cleanup
6. `wsSend` no-op when no open active connection
7. Endpoint/credential change reset

Options type (adapt field names to the monolith):

```typescript
type Options = {
  ready: boolean;
  isConfiguring: boolean;
  // connection descriptor / client from useConnectionConfig
  fontFamily: string;
  fontSize: number;
  notificationsEnabledRef: React.MutableRefObject<boolean>;
  onClearView: () => void;
  onClearPresentation: () => void;
  onCloseDrawer: () => void;
};
```

Rules that must hold after the move (from the design):

- Cache-resident session opens on first visit; switching to a resident session hydrates and does **not** reconnect
- Only the active session schedules React screen updates and may send input / OSC 52 clipboard
- Connection-status describes the **active** session only
- No other hook closes sockets

- [ ] **Step 2: Wire the facade**

```typescript
const sessions = useTerminalSessions({
  // pass connection + viewport + clear callbacks
});
const { /* activeId, connectionStatus, wsSend, switchTo, … */ } = sessions;
```

Delete the moved transport/emulator code from `useTetherApp`. Leave git/file/upload/deep-link glue in the facade.

- [ ] **Step 3: Run pure session tests + typecheck**

Run:

```bash
bun --cwd apps/mobile test src/tether/useTerminalSessions.test.ts
bun --cwd apps/mobile exec tsc --noEmit -p .
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/useTerminalSessions.ts apps/mobile/src/tether/useTerminalSessions.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useTerminalSessions as sole transport owner"
```

---

### Task 9: Extract `useTerminalInput`

**Files:**
- Create: `apps/mobile/src/tether/useTerminalInput.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Existing tests: `apps/mobile/src/input.test.ts` (already covers `applyCtrlToKey` / `applyBackspaceStreak` — do not duplicate)

**Interfaces:**
- Consumes: `send` from sessions, `mouseEnabledRef` from viewport, `getActiveSessionId` + `entryFor` from sessions
- Produces: `ctrlArmed`, `setCtrlArmed`, `sendTyped`, `sendKey`, `sendPaste`, `sendProgram`, `cursorSeq`
- Must never import/create a socket

- [ ] **Step 1: Move input translation into the hook**

```typescript
import { useCallback, useRef, useState } from 'react';
import { applyBackspaceStreak, applyCtrlToKey, EMPTY_STREAK } from '../input';
import type { PtyInputSource } from '../ptyInput';
import type { SessionEntry } from '../sessionCache';

type Options = {
  send: (message: unknown) => void;
  mouseEnabledRef: React.MutableRefObject<boolean>;
  getActiveSessionId: () => string;
  entryFor: (id: string) => SessionEntry;
};

export function useTerminalInput({ send, mouseEnabledRef, getActiveSessionId, entryFor }: Options) {
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const ctrlArmedRef = useRef(false);
  const backspaceStreakRef = useRef(EMPTY_STREAK);
  const setCtrlArmed = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(ctrlArmedRef.current) : next;
    ctrlArmedRef.current = value;
    setCtrlArmedState(value);
  }, []);
  const sendToPty = (source: PtyInputSource, text: string) => {
    if (!text) return;
    const isMouseReport = text.startsWith('\x1b[<') || text.startsWith('\x1b[M');
    if (isMouseReport && !mouseEnabledRef.current) return;
    let bytes = text;
    if (!isMouseReport && (source === 'typed' || source === 'key')) {
      const ctrl = applyCtrlToKey(ctrlArmedRef.current, bytes);
      if (ctrl.consumed) setCtrlArmed(false);
      bytes = ctrl.bytes;
    }
    if (source === 'typed') {
      const tracked = applyBackspaceStreak(backspaceStreakRef.current, bytes, Date.now());
      backspaceStreakRef.current = tracked.streak;
      bytes = tracked.bytes;
    } else if (source === 'key' || source === 'paste') backspaceStreakRef.current = EMPTY_STREAK;
    send({ type: 'input', text: bytes });
  };
  const cursorSeq = (final: string) =>
    `\x1b${entryFor(getActiveSessionId()).term.applicationCursor ? 'O' : '['}${final}`;
  return {
    ctrlArmed,
    setCtrlArmed,
    sendToPty,
    sendTyped: (text: string) => sendToPty('typed', text),
    sendKey: (text: string) => sendToPty('key', text),
    sendPaste: (text: string) => sendToPty('paste', text),
    sendProgram: (text: string) => sendToPty('program', text),
    cursorSeq,
  };
}
```

Wire after sessions exist:

```typescript
const { ctrlArmed, setCtrlArmed, sendTyped, sendKey, sendPaste, sendProgram, cursorSeq } =
  useTerminalInput({ send: wsSend, mouseEnabledRef, getActiveSessionId, entryFor });
```

- [ ] **Step 2: Run input unit tests**

Run: `bun --cwd apps/mobile test src/input.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/tether/useTerminalInput.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useTerminalInput from useTetherApp"
```

---

### Task 10: Extract `usePresentations`

**Files:**
- Create: `apps/mobile/src/tether/usePresentations.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Reuse: `pickAutoSelectPreview` in `apps/mobile/src/presentations.ts` (already pure — add a test there only if missing)

**Interfaces:**
- Consumes: authenticated client/request, `isConfiguring`, `getActiveSessionId`, `markAuthFailed`
- Produces: `presentations`, `activePresentationId`, `setActivePresentationId`, `refreshPresentations`, `closePresentation`

- [ ] **Step 1: Confirm auto-select helper behaviour (add test if absent)**

```typescript
import { expect, test } from 'bun:test';
import { pickAutoSelectPreview } from '../presentations';

test('pickAutoSelectPreview only auto-opens unseen previews for the active session', () => {
  const rows = [
    { id: 'p1', title: 'a', project: 'x', revision: 1, url: '/p1', sessionId: 'term-2' },
    { id: 'p2', title: 'b', project: 'x', revision: 1, url: '/p2', sessionId: 'term-1' },
  ];
  expect(pickAutoSelectPreview(rows, new Set(), 'term-1')?.id).toBe('p2');
  expect(pickAutoSelectPreview(rows, new Set(['p2']), 'term-1')).toBeNull();
});
```

Run: `bun --cwd apps/mobile test` (or the presentations test file you add)
Expected: PASS (or FAIL then implement — helper should already exist).

- [ ] **Step 2: Move poll / seen-ids / close into the hook**

```typescript
type Options = {
  // authenticated client or request helper from connection config
  isConfiguring: boolean;
  getActiveSessionId: () => string;
  markAuthFailed: () => void;
};

export function usePresentations(options: Options) {
  // Move: presentations state, activePresentationId, seenIds ref,
  // refreshPresentations (401 → markAuthFailed), closePresentation,
  // 4s poll effect (pause presentation poll while desktop document.hidden).
}
```

Facade keeps session↔preview navigation helpers that also clear file/diff view (`selectPresentation`, `selectTerminal` clearing presentation id).

- [ ] **Step 3: Typecheck**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/usePresentations.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract usePresentations from useTetherApp"
```

---

### Task 11: Extract `useDesktopEffects`

**Files:**
- Create: `apps/mobile/src/tether/useDesktopEffects.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: already-created input/session/presentation/UI actions and flags (`isConfiguring`, presentation/file/diff open, `sendKey`/`sendPaste`, focus helpers, etc.)
- Produces: nothing user-facing — side-effect-only hook that registers and cleans up every desktop listener it creates
- Registers **no** mobile effects (`if (!isDesktop) return` on each effect)

- [ ] **Step 1: Move desktop DOM bindings**

Cut from `useTetherApp` into `useDesktopEffects`:

- drag-region style injection
- keyboard → terminal / copy / paste / new terminal / font size shortcuts
- wheel / context-menu / focus / visibility
- drag/drop upload trigger (call facade-provided `uploadFile` or paste path if that stays in the facade)

Options should be explicit props — do not reach into other hooks' refs:

```typescript
type Options = {
  isConfiguring: boolean;
  presentations: Presentation[];
  activePresentationId: string | null;
  fileViewOpen: boolean;
  diffOpen: boolean;
  getSessionEntry: (id: string) => SessionEntry | undefined;
  getActiveSessionId: () => string;
  getTerminalSelection: () => string;
  inputRef: React.MutableRefObject<TextInput | null>;
  sendKey: (bytes: string) => void;
  sendPaste: (text: string) => void;
  handlePaste: () => Promise<void>;
  selectAllTerminal: () => void;
  newTerminal: () => void;
  changeFontSize: (delta: number) => void;
  setContextMenu: (position: { x: number; y: number }) => void;
  setWindowFocused: (focused: boolean) => void;
  isWindowFocused: () => boolean;
  refreshSocketActivity: () => void;
  // plus any upload/drop callbacks the monolith already uses
};
```

Every `addEventListener` must have a matching remove in the effect cleanup.

- [ ] **Step 2: Call the hook at the end of facade composition**

```typescript
useDesktopEffects({ /* wire from sessions + input + ui + presentations */ });
```

- [ ] **Step 3: Typecheck**

Run: `bun --cwd apps/mobile exec tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/useDesktopEffects.ts apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): extract useDesktopEffects from useTetherApp"
```

---

### Task 12: Facade composition cleanup

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: all Task 2–11 hooks
- Produces: unchanged public return object

- [ ] **Step 1: Reorder composition to match the design**

```typescript
export function useTetherApp() {
  const connection = useConnectionConfig();
  const preferences = useAppPreferences();
  const viewport = useTerminalViewport();
  const ui = useTerminalUiState();
  const updater = useDesktopUpdater();
  const sessions = useTerminalSessions({ /* connection + viewport + clear cbs */ });
  const presentations = usePresentations({ /* client + session ids */ });
  const input = useTerminalInput({ send: sessions.wsSend, /* … */ });
  useDesktopEffects({ /* input + sessions + presentations + ui */ });

  // Remaining facade-only glue: git/diff, file viewer, upload, deep links,
  // snippet add/remove/send bridges, saveConfig → resetForEndpointChange.
  return { /* existing public fields, mapped from domains */ };
}
```

- [ ] **Step 2: Grep for forbidden ownership leaks**

```bash
rg -n "new WebSocket|TerminalSocket|SessionCache|connect\\(|disconnect\\(" apps/mobile/src/tether/useTerminalInput.ts apps/mobile/src/tether/useDesktopEffects.ts apps/mobile/src/tether/usePresentations.ts apps/mobile/src/tether/useTerminalUiState.ts apps/mobile/src/tether/useAppPreferences.ts apps/mobile/src/tether/useDesktopUpdater.ts apps/mobile/src/tether/useTerminalViewport.ts
```

Expected: no socket/`SessionCache` ownership outside `useTerminalSessions` (+ pure helpers).

- [ ] **Step 3: Confirm consumers still only import the facade**

```bash
rg -n "from ['\\\"].*tether/use" apps/mobile/App.tsx apps/mobile/src/TerminalScreen.tsx
```

Expected: no matches (only `useTetherApp` import path).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): compose useTetherApp from tether domain hooks"
```

---

### Task 13: Verification

**Files:**
- None (run commands only)

- [ ] **Step 1: Run mobile unit tests**

Run: `bun --cwd apps/mobile test`
Expected: PASS.

- [ ] **Step 2: Run lint + typecheck**

Run:

```bash
bun format
bun lint
```

Expected: PASS (Biome + server/mobile typecheck per root scripts).

- [ ] **Step 3: Desktop compile smoke (if on a machine with Rust toolchain)**

Run: `bun --cwd apps/mobile run tauri build` is heavy — prefer:

```bash
cd apps/mobile/src-tauri && cargo check
```

Expected: PASS.

- [ ] **Step 4: Manual checklist (record results in the PR / board note)**

- [ ] Pairing / edit-connection / save still works; address change resets sessions
- [ ] Ordinary terminal input (typed, Ctrl, paste, D-pad)
- [ ] Three live tabs with background output; switch is instant for resident tabs
- [ ] LRU eviction closes the victim socket; explicit kill works
- [ ] Preview auto-select for the active session only; close/reset works
- [ ] Desktop keyboard / wheel / context menu / drag-drop still work; mobile unaffected

- [ ] **Step 5: Final commit only if format/lint touched files**

```bash
git status
# if biome rewrote files:
git add -u
git commit -m "chore(mobile): format after useTetherApp decomposition"
```

---

## Spec coverage (self-review)

| Design requirement | Task(s) |
|---|---|
| `tether/` layout + facade retained | 1–12 |
| `types.ts` shared types only | 1 |
| `useConnectionConfig` | 6 |
| `useAppPreferences` | 2 |
| `useTerminalViewport` | 5 |
| `useTerminalSessions` sole transport/emulator owner | 7–8 |
| `useTerminalInput` never sees sockets | 9, 12 step 2 |
| `usePresentations` | 10 |
| `useTerminalUiState` view-only | 3 |
| `useDesktopEffects` desktop-only + cleanup | 11 |
| `useDesktopUpdater` | 4 |
| Composition dependency order | 12 |
| Per-session connection map + active-only status/input | 7–8 |
| Error/compat + no consumer redesign | Global constraints + 12–13 |
| Pure tests, no new hook framework | 2, 5, 7, 9, 13 |
| Out of scope (protocol, cache cap, App redesign) | Global constraints |

No TBD/placeholder steps remain. Git/file/upload/deep-link stay facade glue by design (not named domains in the spec).
