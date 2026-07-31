# Desktop Sidebar Pin Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On wide desktop, default the session sidebar to a collapsed overlay; let users pin it to the permanent docked column, with the preference persisted across launches.

**Architecture:** Gate the existing `SessionDrawer` `docked`/`visible` props on a persisted `sidebarPinned` preference (default `false`). Unpinned wide desktop uses the same overlay path as compact/mobile, plus a TitleBar hamburger to open it. A pin control inside the drawer toggles the preference. Pure helpers in `desktopLayout.ts` own the boolean gating so UI and tests stay aligned.

**Tech Stack:** React 19, React Native 0.86, Expo 57, TypeScript, AsyncStorage, Bun tests (`bun:test`), Jest + React Native Testing Library (`bun run test:ui`), Tauri desktop shell.

## Global Constraints

- Keep `MIN_DESKTOP_LAYOUT_WIDTH` at `720`.
- Keep `PANEL_W` at `264`.
- Default `sidebarPinned` is `false` (unpinned / collapsed).
- Persist under AsyncStorage key `tether_sidebar_pinned` with string values `"true"` / `"false"`.
- Dock only when `desktopLayout(...) === 'desktop'` **and** `sidebarPinned`.
- Compact desktop and native mobile never show the pin control and never dock from the preference alone.
- No new keyboard shortcut, dependencies, fonts, colors, or animations.
- Do not change host/session/preview/server contracts.

## File map

| File | Responsibility |
|---|---|
| `apps/mobile/src/desktopLayout.ts` | Pure helpers: `sidebarDocked`, `sidebarVisible`, `showTitleBarDrawerMenu` |
| `apps/mobile/src/tether/useAppPreferences.ts` | Load/persist `sidebarPinned` |
| `apps/mobile/src/useTetherApp.tsx` | Expose preference + `persistSidebarPinned` |
| `apps/mobile/src/SessionDrawer.tsx` | Optional pin/unpin button (`showPin`, `onTogglePin`) |
| `apps/mobile/src/TitleBar.tsx` | Optional left hamburger via `onOpenDrawer` |
| `apps/mobile/src/TerminalScreen.tsx` | Wire docked/visible/hamburger/pin/close-on-select |

---

### Task 1: Pure layout helpers + preference parse

**Files:**
- Modify: `apps/mobile/src/desktopLayout.ts`
- Modify: `apps/mobile/src/desktopLayout.test.ts`
- Modify: `apps/mobile/src/tether/useAppPreferences.ts`
- Modify: `apps/mobile/src/tether/useAppPreferences.test.ts`

**Interfaces:**
- Consumes: existing `desktopLayout(isDesktopClient, width)`.
- Produces:
  - `sidebarDocked(desktopUi: boolean, sidebarPinned: boolean): boolean`
  - `sidebarVisible(docked: boolean, drawerOpen: boolean): boolean`
  - `showTitleBarDrawerMenu(desktopUi: boolean, sidebarPinned: boolean): boolean`
  - `parseSidebarPinned(value: string | null): boolean`

- [ ] **Step 1: Write failing helper + parse tests**

Append to `desktopLayout.test.ts`:

```ts
import {
  desktopLayout,
  showTitleBarDrawerMenu,
  sidebarDocked,
  sidebarVisible,
} from './desktopLayout';

describe('sidebar pin gating', () => {
  it('docks only on wide desktop when pinned', () => {
    expect(sidebarDocked(true, true)).toBe(true);
    expect(sidebarDocked(true, false)).toBe(false);
    expect(sidebarDocked(false, true)).toBe(false);
  });

  it('is visible when docked or when the overlay is open', () => {
    expect(sidebarVisible(true, false)).toBe(true);
    expect(sidebarVisible(false, true)).toBe(true);
    expect(sidebarVisible(false, false)).toBe(false);
  });

  it('shows the title-bar drawer menu only on wide desktop when unpinned', () => {
    expect(showTitleBarDrawerMenu(true, false)).toBe(true);
    expect(showTitleBarDrawerMenu(true, true)).toBe(false);
    expect(showTitleBarDrawerMenu(false, false)).toBe(false);
  });
});
```

Append to `useAppPreferences.test.ts`:

```ts
import { parseSidebarPinned, parseSnippets } from './useAppPreferences';

test('parseSidebarPinned accepts only the string true', () => {
  expect(parseSidebarPinned('true')).toBe(true);
  expect(parseSidebarPinned('false')).toBe(false);
  expect(parseSidebarPinned(null)).toBe(false);
  expect(parseSidebarPinned('1')).toBe(false);
  expect(parseSidebarPinned('yes')).toBe(false);
  expect(parseSidebarPinned('')).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun --cwd apps/mobile test src/desktopLayout.test.ts src/tether/useAppPreferences.test.ts
```

Expected: FAIL — helpers / `parseSidebarPinned` not exported.

- [ ] **Step 3: Implement helpers and parser**

In `desktopLayout.ts` add:

```ts
export function sidebarDocked(desktopUi: boolean, sidebarPinned: boolean): boolean {
  return desktopUi && sidebarPinned;
}

export function sidebarVisible(docked: boolean, drawerOpen: boolean): boolean {
  return docked || drawerOpen;
}

export function showTitleBarDrawerMenu(desktopUi: boolean, sidebarPinned: boolean): boolean {
  return desktopUi && !sidebarPinned;
}
```

In `useAppPreferences.ts` add (export; do not wire the hook yet):

```ts
export function parseSidebarPinned(value: string | null): boolean {
  return value === 'true';
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
bun --cwd apps/mobile test src/desktopLayout.test.ts src/tether/useAppPreferences.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/desktopLayout.ts apps/mobile/src/desktopLayout.test.ts \
  apps/mobile/src/tether/useAppPreferences.ts apps/mobile/src/tether/useAppPreferences.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add sidebar pin layout helpers

Pure docked/visible/menu gating and AsyncStorage parse for the
upcoming desktop sidebar pin preference.
EOF
)"
```

---

### Task 2: Persist `sidebarPinned` in app preferences

**Files:**
- Modify: `apps/mobile/src/tether/useAppPreferences.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: `parseSidebarPinned` from Task 1.
- Produces from `useAppPreferences()`:
  - `sidebarPinned: boolean`
  - `persistSidebarPinned: (next: boolean) => void`
- Produces from `useTetherApp()` return: same two fields forwarded.

- [ ] **Step 1: Extend `useAppPreferences`**

```ts
const KEY_SNIPPETS = 'tether_snippets';
const KEY_SIDEBAR_PINNED = 'tether_sidebar_pinned';

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

  return {
    snippets,
    setSnippets,
    persistSnippets,
    sidebarPinned,
    persistSidebarPinned,
  };
}
```

- [ ] **Step 2: Forward through `useTetherApp`**

Where snippets are destructured:

```ts
const { snippets, setSnippets, persistSnippets, sidebarPinned, persistSidebarPinned } =
  useAppPreferences();
```

Add both to the returned object (near `drawerOpen` / `setDrawerOpen` is fine):

```ts
sidebarPinned,
persistSidebarPinned,
```

- [ ] **Step 3: Typecheck the mobile package**

```bash
bun --cwd apps/mobile exec tsc --noEmit
```

Expected: PASS (no consumers required yet; return type widens).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/tether/useAppPreferences.ts apps/mobile/src/useTetherApp.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): persist desktop sidebar pin preference

Load and store tether_sidebar_pinned via AsyncStorage and expose it
through useTetherApp.
EOF
)"
```

---

### Task 3: Pin control in `SessionDrawer`

**Files:**
- Modify: `apps/mobile/src/SessionDrawer.tsx`
- Modify: `apps/mobile/__tests__/SessionDrawer.spec.tsx`

**Interfaces:**
- Consumes: existing drawer props.
- Produces new optional props:
  - `showPin?: boolean` (default `false`)
  - `onTogglePin?: () => void`
- Accessibility labels: `"Pin sidebar"` when `!docked`, `"Unpin sidebar"` when `docked`.

- [ ] **Step 1: Write failing pin-control tests**

Append to `SessionDrawer.spec.tsx`:

```tsx
test('hides the pin control unless showPin is set', () => {
  const { view } = renderDrawer();
  expect(view.queryByLabelText('Pin sidebar')).toBeNull();
  expect(view.queryByLabelText('Unpin sidebar')).toBeNull();
});

test('shows Pin sidebar when showPin and not docked', () => {
  const onTogglePin = jest.fn();
  const { view } = renderDrawer({ showPin: true, docked: false, onTogglePin });
  fireEvent.press(view.getByLabelText('Pin sidebar'));
  expect(onTogglePin).toHaveBeenCalled();
});

test('shows Unpin sidebar when showPin and docked', () => {
  const onTogglePin = jest.fn();
  const { view } = renderDrawer({ showPin: true, docked: true, onTogglePin });
  fireEvent.press(view.getByLabelText('Unpin sidebar'));
  expect(onTogglePin).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify fail**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/SessionDrawer.spec.tsx
```

Expected: FAIL — pin labels missing.

- [ ] **Step 3: Add pin button UI**

In `SessionDrawerProps` add:

```ts
showPin?: boolean;
onTogglePin?: () => void;
```

Destructure with defaults `showPin = false`. At the top of `panelBody` (before the `ScrollView`), when `showPin && onTogglePin`:

```tsx
{showPin && onTogglePin ? (
  <View style={styles.pinRow}>
    <TouchableOpacity
      onPress={onTogglePin}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={docked ? 'Unpin sidebar' : 'Pin sidebar'}
      style={styles.pinBtn}
    >
      <Feather name="pin" size={16} color={theme.colors.textMuted} />
      <Text style={styles.pinLabel}>{docked ? 'Unpin' : 'Pin'}</Text>
    </TouchableOpacity>
  </View>
) : null}
```

Add styles:

```ts
pinRow: {
  flexDirection: 'row',
  justifyContent: 'flex-end',
  paddingHorizontal: 4,
  paddingBottom: 4,
},
pinBtn: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  minHeight: MIN_TOUCH_TARGET,
  paddingHorizontal: 8,
},
pinLabel: { color: c.textMuted, fontSize: 12, fontWeight: '600' },
```

- [ ] **Step 4: Run tests and verify pass**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/SessionDrawer.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/SessionDrawer.tsx apps/mobile/__tests__/SessionDrawer.spec.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add pin control to session drawer

Optional showPin header toggle for docking the desktop sidebar.
EOF
)"
```

---

### Task 4: TitleBar drawer hamburger

**Files:**
- Modify: `apps/mobile/src/TitleBar.tsx`
- Modify: `apps/mobile/__tests__/TitleBar.spec.tsx`

**Interfaces:**
- Consumes: existing `TitleBarProps`.
- Produces: optional `onOpenDrawer?: () => void` — when set, renders a left hamburger with accessibility label `"Open terminal list"` (same as the mobile header).

- [ ] **Step 1: Write failing TitleBar tests**

Append to `TitleBar.spec.tsx`:

```tsx
test('renders a left drawer button when onOpenDrawer is provided', () => {
  const onOpenDrawer = jest.fn();
  const view = render(
    <AppThemeProvider>
      <TitleBar isMac={false} title="term-1" onOpenDrawer={onOpenDrawer} />
    </AppThemeProvider>,
  );
  fireEvent.press(view.getByLabelText('Open terminal list'));
  expect(onOpenDrawer).toHaveBeenCalled();
});

test('hides the drawer button when onOpenDrawer is omitted', () => {
  const view = render(
    <AppThemeProvider>
      <TitleBar isMac={false} title="term-1" />
    </AppThemeProvider>,
  );
  expect(view.queryByLabelText('Open terminal list')).toBeNull();
});
```

- [ ] **Step 2: Run and verify fail**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/TitleBar.spec.tsx
```

Expected: FAIL — label not found / prop unused.

- [ ] **Step 3: Implement hamburger**

Add to `TitleBarProps`:

```ts
onOpenDrawer?: () => void;
```

Destructure `onOpenDrawer`. In the bar, **after** the macOS left inset and **before** `styles.info`:

```tsx
{onOpenDrawer ? (
  <TouchableOpacity
    {...NO_DRAG_PROPS}
    style={styles.btn}
    activeOpacity={0.6}
    hitSlop={HIT}
    onPress={onOpenDrawer}
    accessibilityRole="button"
    accessibilityLabel="Open terminal list"
  >
    <Feather name="menu" size={18} color={theme.colors.text} />
  </TouchableOpacity>
) : null}
```

- [ ] **Step 4: Run tests and verify pass**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/TitleBar.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/TitleBar.tsx apps/mobile/__tests__/TitleBar.spec.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add title-bar drawer menu button

Optional onOpenDrawer hamburger for unpinned wide-desktop sidebar.
EOF
)"
```

---

### Task 5: Wire `TerminalScreen` + update desktop drawer tests

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/__tests__/DesktopTerminalDrawer.spec.tsx`
- Modify: `apps/mobile/__tests__/GitShellRouting.spec.tsx` (add fixture fields if the Proxy does not already cover new names — it uses a Proxy fallback to `noop`, so likely no change; only touch if TypeScript/tests complain)

**Interfaces:**
- Consumes: `sidebarPinned`, `persistSidebarPinned`, helpers from Task 1, pin props from Task 3, `onOpenDrawer` from Task 4.
- Produces: full pin-mode behavior per the spec.

- [ ] **Step 1: Rewrite failing desktop drawer expectations**

In `DesktopTerminalDrawer.spec.tsx`:

1. Extend `appFixture` / `known` with:

```ts
sidebarPinned: false,
persistSidebarPinned: noop,
```

And change the harness to accept pin state:

```tsx
function appFixture(
  drawerOpen: boolean,
  setDrawerOpen: (open: boolean) => void,
  sidebarPinned = false,
  persistSidebarPinned: (next: boolean) => void = jest.fn(),
) {
  // ...
  sidebarPinned,
  persistSidebarPinned,
  // ...
}

function Harness({ initialPinned = false }: { initialPinned?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(initialPinned);
  return (
    <TerminalScreen
      app={appFixture(drawerOpen, setDrawerOpen, sidebarPinned, setSidebarPinned)}
    />
  );
}
```

2. Replace the TitleBar mock with a stub that surfaces `onOpenDrawer`:

```tsx
jest.mock('../src/TitleBar', () => {
  const { TouchableOpacity, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onOpenDrawer }: { onOpenDrawer?: () => void }) =>
      onOpenDrawer ? (
        <TouchableOpacity accessibilityLabel="Open terminal list" onPress={onOpenDrawer}>
          <Text>menu</Text>
        </TouchableOpacity>
      ) : null,
  };
});
```

3. Replace / add tests:

```tsx
test('keeps the host drawer collapsed by default at wide desktop widths', () => {
  const view = renderTerminal(1024);
  expect(view.queryByLabelText('Studio host section')).toBeNull();
  expect(view.getByLabelText('Open terminal list')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Open terminal list'));
  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.getByLabelText('Pin sidebar')).toBeTruthy();
});

test('docks the host drawer when sidebarPinned is true', () => {
  setWindowWidth(1024);
  const view = render(
    <SafeAreaProvider /* same metrics as renderTerminal */>
      <AppThemeProvider>
        <Harness initialPinned />
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.queryByLabelText('Open terminal list')).toBeNull();
  expect(view.getByLabelText('Unpin sidebar')).toBeTruthy();
});

test('switches the same host drawer to an overlay below the desktop breakpoint', () => {
  // existing compact test — still valid; pin control must be absent
  const view = renderTerminal(640);
  expect(view.queryByLabelText('Studio host section')).toBeNull();
  fireEvent.press(view.getByLabelText('Open terminal list'));
  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.queryByLabelText('Pin sidebar')).toBeNull();
});
```

Update `renderTerminal` to use `<Harness />` (unpinned default) as today.

- [ ] **Step 2: Run and verify fail**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/DesktopTerminalDrawer.spec.tsx
```

Expected: FAIL — wide desktop still docks unconditionally / no pin wiring.

- [ ] **Step 3: Wire `TerminalScreen`**

Destructure from `app`:

```ts
sidebarPinned,
persistSidebarPinned,
```

Import helpers:

```ts
import {
  desktopLayout,
  showTitleBarDrawerMenu,
  sidebarDocked,
  sidebarVisible,
} from './desktopLayout';
```

After `desktopUi`:

```ts
const docked = sidebarDocked(desktopUi, sidebarPinned);
const drawerVisible = sidebarVisible(docked, drawerOpen);
const titleBarDrawerMenu = showTitleBarDrawerMenu(desktopUi, sidebarPinned);

const toggleSidebarPin = () => {
  if (sidebarPinned) {
    persistSidebarPinned(false);
    setDrawerOpen(false);
  } else {
    persistSidebarPinned(true);
  }
};
```

Update `TitleBar`:

```tsx
{isDesktop && (
  <TitleBar
    /* existing props */
    onOpenDrawer={
      titleBarDrawerMenu
        ? () => {
            refreshSessions();
            refreshPresentations();
            setDrawerOpen(true);
          }
        : undefined
    }
    compact={!desktopUi}
  />
)}
```

Update `SessionDrawer`:

```tsx
<SessionDrawer
  visible={drawerVisible}
  docked={docked}
  showPin={desktopUi}
  onTogglePin={toggleSidebarPin}
  /* ... */
  onSelect={(hostId, id) => {
    selectTerminal(hostId, id);
    if (!docked) setDrawerOpen(false);
  }}
  onSelectPreview={(id) => {
    selectPresentation(id);
    if (!docked) setDrawerOpen(false);
  }}
  onClose={() => setDrawerOpen(false)}
  onHostSettings={(hostId) => {
    if (!docked) setDrawerOpen(false);
    openServerSettings(hostId);
  }}
/>
```

Important: today `onSelect={selectTerminal}` does not close on wide desktop. Replace with the wrapper above so unpinned wide desktop closes like mobile. Keep `terminalBody` row layout when `desktopUi` **and** `docked` so an open overlay does not shrink the terminal column:

```tsx
<View style={[styles.terminalBody, docked && styles.terminalRow]}>
```

(If `terminalRow` is currently gated on `desktopUi`, switch that gate to `docked` — unpinned overlay must not reserve sidebar width.)

- [ ] **Step 4: Run desktop drawer tests and verify pass**

```bash
cd apps/mobile && bun run test:ui --runInBand __tests__/DesktopTerminalDrawer.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Run related suites + typecheck**

```bash
cd apps/mobile && bun run test:ui --runInBand \
  __tests__/DesktopTerminalDrawer.spec.tsx \
  __tests__/SessionDrawer.spec.tsx \
  __tests__/TitleBar.spec.tsx \
  __tests__/GitShellRouting.spec.tsx
bun --cwd apps/mobile test src/desktopLayout.test.ts src/tether/useAppPreferences.test.ts
bun --cwd apps/mobile exec tsc --noEmit
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/TerminalScreen.tsx \
  apps/mobile/__tests__/DesktopTerminalDrawer.spec.tsx \
  apps/mobile/__tests__/GitShellRouting.spec.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): wire desktop sidebar pin mode

Default wide desktop to a collapsed overlay; pin docks the drawer and
persists. Title-bar hamburger opens the overlay when unpinned.
EOF
)"
```

---

### Task 6: Manual verification checklist

**Files:** none (manual only).

- [ ] **Step 1: Run Tauri desktop (or existing desktop build)**

```bash
bun --cwd apps/mobile run tauri:dev
```

- [ ] **Step 2: Verify behavior**

Checklist:

1. Fresh / cleared `tether_sidebar_pinned` → wide window: no docked sidebar; hamburger in title bar.
2. Open via hamburger → overlay + Pin control; select a session → overlay closes.
3. Open → Pin → sidebar docks; hamburger gone; Unpin → collapses closed.
4. Pin, quit app, relaunch → still docked.
5. Shrink below 720 while pinned → compact overlay (mobile header); grow again → docked.
6. Mobile / narrow: no Pin control; existing menu still works.

- [ ] **Step 3: Commit nothing unless fixes were needed; if fixes were needed, commit them with a focused message and re-run Task 5 Step 5.**

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Default unpinned overlay on wide desktop | 1, 5 |
| Persist `tether_sidebar_pinned` `"true"`/`"false"` | 1, 2 |
| TitleBar hamburger only when unpinned | 1, 4, 5 |
| Pin control in drawer; pin/unpin transitions | 3, 5 |
| Close-on-select when unpinned | 5 |
| Compact/mobile unchanged, no pin | 3, 5 |
| Resize keeps preference; docks when wide again | 1, 5 (helpers + `desktopUi` gate) |
| Tests for parse, gating, drawer, TitleBar, desktop integration | 1, 3, 4, 5 |
| No keyboard shortcut / hover / tabs | Non-goals — not implemented |

## Self-review notes

- No TBD/placeholder steps.
- Helper names (`sidebarDocked`, `sidebarVisible`, `showTitleBarDrawerMenu`, `parseSidebarPinned`, `persistSidebarPinned`) are consistent across tasks.
- Overlay must not use `terminalRow` while unpinned — called out explicitly in Task 5 so the terminal keeps full width under the overlay.
