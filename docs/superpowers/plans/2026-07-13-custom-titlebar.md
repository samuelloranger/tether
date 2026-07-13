# Custom Titlebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tether desktop's native OS title bar with a custom in-app toolbar that carries the app chrome and window controls, on macOS, Windows, and Linux.

**Architecture:** The Tauri window goes frameless (`decorations: false`) on Windows/Linux where we draw our own min/max/close cluster; macOS keeps its native traffic lights via `titleBarStyle: "Overlay"` (applied through a platform-specific config file). A new `TitleBar` react-native-web component replaces the current `styles.header`, provides a `data-tauri-drag-region` for window dragging, and hosts the existing header content (session name, connection badge, overflow menu, new-terminal + settings actions). The docked `SessionDrawer` sidebar is unchanged and remains the session switcher — the title bar does **not** duplicate session tabs.

**Tech Stack:** Tauri v2, `@tauri-apps/api/window` (already a dependency, `@tauri-apps/api@^2`), Expo React Native / react-native-web (SDK 57 / RN 0.86 / React 19), `bun test`.

## Global Constraints

- Runtime: Bun ≥ 1.3.14 (server PTY requirement; unrelated to this feature but the repo floor).
- Desktop === `Platform.OS === 'web'`; the flag `isDesktop` and `isMacDesktop` already exist in `apps/mobile/App.tsx`. No change to the mobile (iOS/Android) app.
- Formatting: Biome style for touched TS — 2-space indent, single quotes, semicolons, trailing commas, width 100.
- Tauri deps are imported **lazily** via `await import(...)` so they never enter the mobile bundle (existing pattern in `src/dialog.ts`, `src/wsTransport.ts`, `src/desktopUpdate.ts`).
- Tests are `bun test` only; there is no RN render-test harness. Pure logic is unit-tested; components/config are verified by typecheck (`bun --cwd apps/mobile run lint` → `tsc --noEmit`) plus manual per-OS build.
- macOS platform config MUST repeat the **entire** `app.windows[0]` object — JSON Merge Patch (RFC 7396) replaces arrays wholesale.
- Windows Snap Layouts are out of scope (Phase 3, native `WM_NCHITTEST` hook).
- `bun` must be on PATH for all commands below (`~/.bun/bin`).

---

## File Structure

- Modify `apps/mobile/src-tauri/tauri.conf.json` — base window gets `decorations: false`.
- Create `apps/mobile/src-tauri/tauri.macos.conf.json` — macOS overrides (full window object).
- Modify `apps/mobile/src-tauri/capabilities/default.json` — window-control permissions.
- Create `apps/mobile/src/titlebarChrome.ts` — pure per-platform layout decisions.
- Create `apps/mobile/src/titlebarChrome.test.ts` — unit tests for the above.
- Create `apps/mobile/src/dragRegion.ts` — drag-region CSS string, injector, and RN-web `dataSet` prop bundles.
- Create `apps/mobile/src/dragRegion.test.ts` — unit test for the CSS constant.
- Create `apps/mobile/src/windowControls.ts` — lazy `@tauri-apps/api/window` wrapper.
- Create `apps/mobile/src/TitleBar.tsx` — the toolbar component.
- Modify `apps/mobile/App.tsx` — render `<TitleBar>` in place of `styles.header` on desktop; inject drag styles on mount; add title-bar styles.

---

## Task 1: Frameless window config + capabilities

**Files:**
- Modify: `apps/mobile/src-tauri/tauri.conf.json` (the `app.windows[0]` object)
- Create: `apps/mobile/src-tauri/tauri.macos.conf.json`
- Modify: `apps/mobile/src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: a frameless window on Windows/Linux; native traffic lights on macOS. No code symbols.

- [ ] **Step 1: Add `decorations: false` to the base window**

Edit `apps/mobile/src-tauri/tauri.conf.json` so the `app.windows` array reads exactly:

```json
"windows": [
  {
    "title": "Tether",
    "width": 1000,
    "height": 720,
    "minWidth": 640,
    "minHeight": 480,
    "decorations": false
  }
]
```

- [ ] **Step 2: Create the macOS override file**

Create `apps/mobile/src-tauri/tauri.macos.conf.json` with the **full** window object (array is replaced wholesale, so every base field is repeated):

```json
{
  "app": {
    "windows": [
      {
        "title": "Tether",
        "width": 1000,
        "height": 720,
        "minWidth": 640,
        "minHeight": 480,
        "decorations": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true
      }
    ]
  }
}
```

- [ ] **Step 3: Add window-control permissions**

Edit `apps/mobile/src-tauri/capabilities/default.json` — add the five window permissions to the `permissions` array so it reads:

```json
"permissions": [
  "core:default",
  "updater:default",
  "process:default",
  "dialog:default",
  "opener:allow-open-url",
  "core:window:allow-minimize",
  "core:window:allow-close",
  "core:window:allow-toggle-maximize",
  "core:window:allow-start-dragging",
  "core:window:allow-is-maximized"
]
```

- [ ] **Step 4: Validate all three JSON files parse**

Run (from repo root):
```bash
node -e "for (const f of ['apps/mobile/src-tauri/tauri.conf.json','apps/mobile/src-tauri/tauri.macos.conf.json','apps/mobile/src-tauri/capabilities/default.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok', f); }"
```
Expected: three `ok <path>` lines, no parse error.

> Note: full schema validation and the actual frameless window require a Tauri build (no Rust toolchain here); that is verified via the `workflow_dispatch` desktop CI job and manual per-OS testing at the end of the plan.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src-tauri/tauri.conf.json apps/mobile/src-tauri/tauri.macos.conf.json apps/mobile/src-tauri/capabilities/default.json
git commit -m "feat(desktop): frameless window config + window-control capabilities

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `titlebarChrome.ts` — pure per-platform decisions

**Files:**
- Create: `apps/mobile/src/titlebarChrome.ts`
- Test: `apps/mobile/src/titlebarChrome.test.ts`

**Interfaces:**
- Produces:
  - `MAC_TRAFFIC_LIGHT_INSET: number` — left inset (px) reserved for macOS traffic lights.
  - `titlebarChrome(isMac: boolean): { showControls: boolean; leftInset: number }` — `showControls` is `true` only off macOS (custom min/max/close); `leftInset` is `MAC_TRAFFIC_LIGHT_INSET` on macOS else `0`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/titlebarChrome.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { MAC_TRAFFIC_LIGHT_INSET, titlebarChrome } from './titlebarChrome';

describe('titlebarChrome', () => {
  it('macOS: no custom controls, reserves traffic-light inset', () => {
    expect(titlebarChrome(true)).toEqual({ showControls: false, leftInset: MAC_TRAFFIC_LIGHT_INSET });
  });
  it('Windows/Linux: custom controls, no inset', () => {
    expect(titlebarChrome(false)).toEqual({ showControls: true, leftInset: 0 });
  });
  it('inset is a positive number', () => {
    expect(MAC_TRAFFIC_LIGHT_INSET).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/mobile`): `bun test src/titlebarChrome.test.ts`
Expected: FAIL — cannot resolve `./titlebarChrome`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/titlebarChrome.ts`:

```typescript
// Pure per-platform decisions for the custom title bar. macOS keeps its native
// traffic lights (drawn by the OS via titleBarStyle: Overlay), so we render no
// custom window controls there and instead reserve a left inset the toolbar
// content leaves clear. Windows/Linux are frameless — we draw the controls.

// Width reserved on macOS for the three native traffic-light buttons. Empirical;
// confirm against the real Overlay geometry during manual testing.
export const MAC_TRAFFIC_LIGHT_INSET = 72;

export function titlebarChrome(isMac: boolean): { showControls: boolean; leftInset: number } {
  return {
    showControls: !isMac,
    leftInset: isMac ? MAC_TRAFFIC_LIGHT_INSET : 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/mobile`): `bun test src/titlebarChrome.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/titlebarChrome.ts apps/mobile/src/titlebarChrome.test.ts
git commit -m "feat(desktop): titlebarChrome per-platform layout helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `dragRegion.ts` — drag CSS + RN-web prop bundles

**Files:**
- Create: `apps/mobile/src/dragRegion.ts`
- Test: `apps/mobile/src/dragRegion.test.ts`

**Interfaces:**
- Produces:
  - `DRAG_REGION_CSS: string` — the stylesheet mapping `[data-tauri-drag-region]` → `app-region: drag` and `[data-tauri-no-drag]` → `app-region: no-drag` (both prefixed + unprefixed).
  - `injectDragRegionStyles(): void` — inserts `DRAG_REGION_CSS` once into `document.head` (id-guarded; no-op if already present or `document` is undefined).
  - `DRAG_PROPS: any` — spread onto the toolbar background View → `data-tauri-drag-region`.
  - `NO_DRAG_PROPS: any` — spread onto every interactive control → `data-tauri-no-drag`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/dragRegion.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { DRAG_PROPS, DRAG_REGION_CSS, NO_DRAG_PROPS } from './dragRegion';

describe('dragRegion', () => {
  it('CSS maps drag and no-drag regions, prefixed and unprefixed', () => {
    expect(DRAG_REGION_CSS).toContain('[data-tauri-drag-region]');
    expect(DRAG_REGION_CSS).toContain('[data-tauri-no-drag]');
    expect(DRAG_REGION_CSS).toContain('app-region: drag');
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: drag');
    expect(DRAG_REGION_CSS).toContain('app-region: no-drag');
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: no-drag');
  });
  it('prop bundles carry the expected data attributes', () => {
    expect(DRAG_PROPS.dataSet.tauriDragRegion).toBe('');
    expect(NO_DRAG_PROPS.dataSet.tauriNoDrag).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/mobile`): `bun test src/dragRegion.test.ts`
Expected: FAIL — cannot resolve `./dragRegion`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/dragRegion.ts`:

```typescript
// Window-drag support for the custom title bar (desktop/web only).
//
// Tauri turns any element with `data-tauri-drag-region` into a window drag
// handle (and double-click → maximize). On Windows the drag is region-based, so
// interactive children must opt OUT with `data-tauri-no-drag`, else they become
// dead zones. react-native-web renders `dataSet={{ tauriDragRegion: '' }}` as
// the `data-tauri-drag-region` attribute; the `app-region` CSS below is what
// Windows needs for touch/pen dragging (`-webkit-` for WebKitGTK/WKWebView).

export const DRAG_REGION_CSS = `
[data-tauri-drag-region] { app-region: drag; -webkit-app-region: drag; }
[data-tauri-no-drag] { app-region: no-drag; -webkit-app-region: no-drag; }
`;

const STYLE_ID = 'tether-drag-region-styles';

export function injectDragRegionStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = DRAG_REGION_CSS;
  document.head.appendChild(el);
}

// RN-web's View type (from `react-native`) doesn't declare `dataSet`, so these
// are typed `any` and spread onto the target View.
export const DRAG_PROPS: any = { dataSet: { tauriDragRegion: '' } };
export const NO_DRAG_PROPS: any = { dataSet: { tauriNoDrag: '' } };
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/mobile`): `bun test src/dragRegion.test.ts`
Expected: PASS (2 pass).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/dragRegion.ts apps/mobile/src/dragRegion.test.ts
git commit -m "feat(desktop): drag-region CSS + RN-web prop bundles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `windowControls.ts` — lazy window API wrapper

**Files:**
- Create: `apps/mobile/src/windowControls.ts`

**Interfaces:**
- Consumes: `@tauri-apps/api/window` (`getCurrentWindow`).
- Produces:
  - `minimizeWindow(): Promise<void>`
  - `toggleMaximizeWindow(): Promise<void>`
  - `closeWindow(): Promise<void>`
  - `isWindowMaximized(): Promise<boolean>`
  - `onMaximizeChange(cb: (maximized: boolean) => void): Promise<() => void>` — subscribes to window resize and reports maximized state; returns an unlisten fn.

- [ ] **Step 1: Write the implementation**

Create `apps/mobile/src/windowControls.ts`:

```typescript
// Custom-title-bar window controls (desktop/web only). Wraps @tauri-apps/api's
// window API, imported lazily so it never enters the mobile bundle (same pattern
// as src/dialog.ts). Used on Windows/Linux, where we draw our own min/max/close;
// macOS keeps its native traffic lights and does not call these.

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await win()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await win()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await (await win()).close();
}

export async function isWindowMaximized(): Promise<boolean> {
  return (await win()).isMaximized();
}

// Fire cb with the current maximized state now and on every resize (maximize,
// restore, snap). Returns an unlisten function.
export async function onMaximizeChange(cb: (maximized: boolean) => void): Promise<() => void> {
  const w = await win();
  cb(await w.isMaximized());
  return w.onResized(async () => {
    cb(await w.isMaximized());
  });
}
```

- [ ] **Step 2: Typecheck**

Run (from repo root): `bun --cwd apps/mobile run lint`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/windowControls.ts
git commit -m "feat(desktop): windowControls wrapper over @tauri-apps/api/window

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `TitleBar.tsx` — the toolbar component

**Files:**
- Create: `apps/mobile/src/TitleBar.tsx`

**Interfaces:**
- Consumes: `titlebarChrome` (Task 2), `DRAG_PROPS`/`NO_DRAG_PROPS` (Task 3), `minimizeWindow`/`toggleMaximizeWindow`/`closeWindow`/`onMaximizeChange` (Task 4).
- Produces: default export `TitleBar` with props:
  ```typescript
  export interface TitleBarProps {
    isMac: boolean;
    title: string;                 // active session name
    subtitle: string;              // `${serverIp}:${port}`
    status: 'connected' | 'connecting' | 'auth-failed' | 'offline';
    onNew: () => void;
    onSettings: () => void;
    onMenu: () => void;            // opens the overflow (⋯) menu
  }
  ```

- [ ] **Step 1: Write the component**

Create `apps/mobile/src/TitleBar.tsx`:

```tsx
// Custom window title bar for the desktop build. Replaces the OS titlebar: the
// whole bar is a Tauri drag region (drag to move, double-click to maximize);
// interactive controls opt out via NO_DRAG_PROPS. macOS keeps native traffic
// lights (we reserve a left inset); Windows/Linux get the custom min/max/close
// cluster on the right. See src/titlebarChrome.ts for the per-OS decisions.
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { titlebarChrome } from './titlebarChrome';
import { DRAG_PROPS, NO_DRAG_PROPS } from './dragRegion';
import {
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  onMaximizeChange,
} from './windowControls';

export interface TitleBarProps {
  isMac: boolean;
  title: string;
  subtitle: string;
  status: 'connected' | 'connecting' | 'auth-failed' | 'offline';
  onNew: () => void;
  onSettings: () => void;
  onMenu: () => void;
}

const HIT = { top: 8, bottom: 8, left: 6, right: 6 };

function StatusBadge({ status }: { status: TitleBarProps['status'] }) {
  if (status === 'connected') {
    return (
      <View style={[styles.badge, styles.badgeOk]}>
        <View style={[styles.dot, styles.dotOk]} />
        <Text style={styles.badgeTextOk}>Connected</Text>
      </View>
    );
  }
  if (status === 'connecting') {
    return (
      <View style={[styles.badge, styles.badgeWarn]}>
        <ActivityIndicator size={8} color="#fbbf24" style={{ marginRight: 5 }} />
        <Text style={styles.badgeTextWarn}>Connecting…</Text>
      </View>
    );
  }
  const label = status === 'auth-failed' ? 'Auth' : 'Offline';
  return (
    <View style={[styles.badge, styles.badgeOff]}>
      <View style={[styles.dot, styles.dotOff]} />
      <Text style={styles.badgeTextOff}>{label}</Text>
    </View>
  );
}

export default function TitleBar({
  isMac,
  title,
  subtitle,
  status,
  onNew,
  onSettings,
  onMenu,
}: TitleBarProps) {
  const { showControls, leftInset } = titlebarChrome(isMac);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!showControls) return;
    let unlisten: (() => void) | undefined;
    onMaximizeChange(setMaximized).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showControls]);

  return (
    <View style={styles.bar} {...DRAG_PROPS}>
      {leftInset > 0 && <View style={{ width: leftInset }} />}

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <View style={styles.actions}>
        <StatusBadge status={status} />

        <TouchableOpacity
          {...NO_DRAG_PROPS}
          style={styles.btn}
          activeOpacity={0.6}
          hitSlop={HIT}
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel="New terminal"
        >
          <Feather name="plus" size={19} color="#cbd5e1" />
        </TouchableOpacity>

        <TouchableOpacity
          {...NO_DRAG_PROPS}
          style={styles.btn}
          activeOpacity={0.6}
          hitSlop={HIT}
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Feather name="settings" size={18} color="#cbd5e1" />
        </TouchableOpacity>

        <TouchableOpacity
          {...NO_DRAG_PROPS}
          style={styles.btn}
          activeOpacity={0.6}
          hitSlop={HIT}
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Terminal menu"
        >
          <Feather name="more-vertical" size={19} color="#cbd5e1" />
        </TouchableOpacity>

        {showControls && (
          <View style={styles.winControls}>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={styles.winBtn}
              activeOpacity={0.6}
              onPress={() => void minimizeWindow()}
              accessibilityRole="button"
              accessibilityLabel="Minimize"
            >
              <Feather name="minus" size={18} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={styles.winBtn}
              activeOpacity={0.6}
              onPress={() => void toggleMaximizeWindow()}
              accessibilityRole="button"
              accessibilityLabel={maximized ? 'Restore' : 'Maximize'}
            >
              <Feather name={maximized ? 'copy' : 'square'} size={15} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={[styles.winBtn, styles.winClose]}
              activeOpacity={0.6}
              onPress={() => void closeWindow()}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={18} color="#cbd5e1" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingLeft: 12,
    backgroundColor: '#0b0f19',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  subtitle: { color: '#64748b', fontSize: 11 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingHorizontal: 8, paddingVertical: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginRight: 4,
  },
  badgeOk: { backgroundColor: 'rgba(34,197,94,0.12)' },
  badgeWarn: { backgroundColor: 'rgba(251,191,36,0.12)' },
  badgeOff: { backgroundColor: 'rgba(148,163,184,0.12)' },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  dotOk: { backgroundColor: '#22c55e' },
  dotOff: { backgroundColor: '#94a3b8' },
  badgeTextOk: { color: '#22c55e', fontSize: 11, fontWeight: '600' },
  badgeTextWarn: { color: '#fbbf24', fontSize: 11, fontWeight: '600' },
  badgeTextOff: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  winControls: { flexDirection: 'row', alignItems: 'center', marginLeft: 6 },
  winBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  winClose: {},
});
```

- [ ] **Step 2: Typecheck**

Run (from repo root): `bun --cwd apps/mobile run lint`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/TitleBar.tsx
git commit -m "feat(desktop): TitleBar component with drag region + window controls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire `TitleBar` into `App.tsx`

**Files:**
- Modify: `apps/mobile/App.tsx` — import + inject styles on mount + render `<TitleBar>` on desktop, keeping the existing `styles.header` for mobile.

**Interfaces:**
- Consumes: `TitleBar` (Task 5), `injectDragRegionStyles` (Task 3), existing `isDesktop`, `isMacDesktop`, `activeName`, `serverIp`, `port`, `connectionStatus`, `newTerminal`, `setIsConfiguring`, `setMenuOpen`.

- [ ] **Step 1: Add imports**

In `apps/mobile/App.tsx`, after the existing `import { fetchUpdate, ... } from './src/desktopUpdate';` line, add:

```typescript
import TitleBar from './src/TitleBar';
import { injectDragRegionStyles } from './src/dragRegion';
```

- [ ] **Step 2: Inject drag styles once on desktop**

In `AppInner`, alongside the other desktop `useEffect`s (e.g. near the keydown effect around line 963), add:

```typescript
  // Desktop: install the window drag-region CSS once (custom title bar).
  useEffect(() => {
    if (isDesktop) injectDragRegionStyles();
  }, []);
```

- [ ] **Step 3: Map `connectionStatus` to the TitleBar status union**

Immediately before the `return (` of `AppInner`'s main render, add:

```typescript
  const titleBarStatus: 'connected' | 'connecting' | 'auth-failed' | 'offline' =
    connectionStatus === 'connected'
      ? 'connected'
      : connectionStatus === 'connecting'
        ? 'connecting'
        : connectionStatus === 'auth-failed'
          ? 'auth-failed'
          : 'offline';
```

> If `connectionStatus` is already exactly this union, use it directly and skip this step. Verify by checking its declaration in `App.tsx` (search `connectionStatus`).

- [ ] **Step 4: Render `TitleBar` on desktop, keep the header on mobile**

In `apps/mobile/App.tsx`, replace the header block. Change the opening of the header from:

```tsx
          {/* Header Panel */}
          <View style={styles.header}>
            {!isDesktop && (
```

to:

```tsx
          {/* Desktop: custom window title bar (replaces the OS titlebar). */}
          {isDesktop && (
            <TitleBar
              isMac={isMacDesktop}
              title={activeName}
              subtitle={`${serverIp}:${port}`}
              status={titleBarStatus}
              onNew={newTerminal}
              onSettings={() => setIsConfiguring(true)}
              onMenu={() => setMenuOpen(true)}
            />
          )}
          {/* Mobile header panel */}
          {!isDesktop && (
          <View style={styles.header}>
            {!isDesktop && (
```

Then find the matching close of that header `View` (the `</View>` that closes `<View style={styles.header}>`, currently at line 1416) and change it from:

```tsx
          </View>
```

to:

```tsx
          </View>
          )}
```

> This wraps the entire existing mobile header (menu button, `headerInfo`, `headerControls`) in `{!isDesktop && ( ... )}` so it renders on mobile only, while desktop uses `<TitleBar>` above it. The `newTerminal` handler must exist; if the codebase names it differently (e.g. the SessionDrawer `onNew` prop passes a different function), pass that same function here — check the docked `SessionDrawer` usage (~line 1354).

- [ ] **Step 5: Typecheck**

Run (from repo root): `bun --cwd apps/mobile run lint`
Expected: exit 0, no errors.

- [ ] **Step 6: Run the full mobile test suite (no regressions)**

Run (from `apps/mobile`): `bun test`
Expected: all tests pass (including the new `titlebarChrome` and `dragRegion` suites).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(desktop): render custom TitleBar in place of the OS titlebar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Manual per-OS verification (build via CI)

**Files:** none (verification only).

- [ ] **Step 1: Trigger the desktop build for all three OSes**

The consolidated `.github/workflows/release.yml` has a `workflow_dispatch` build-only path. Push the branch and run it:

```bash
git push -u origin feat/desktop-custom-titlebar
gh workflow run "Release builds" --ref feat/desktop-custom-titlebar -f scope=desktop
gh run watch
```
Expected: the `desktop` matrix (macOS ×2, Windows, ubuntu-24.04, ubuntu-26.04) succeeds and uploads workflow artifacts.

- [ ] **Step 2: Verify on each OS**

Download the artifact per OS and confirm:
- **macOS:** native traffic lights appear top-left over the bar; title text hidden; green button enters native fullscreen; toolbar content clears the ~72px inset (adjust `MAC_TRAFFIC_LIGHT_INSET` in `titlebarChrome.ts` if it overlaps/gaps); dragging the empty bar moves the window; double-click maximizes.
- **Windows:** custom min/max/close on the right work; drag + double-click-maximize work; maximize icon toggles to restore; no native titlebar shown.
- **Linux (AppImage + deb):** same as Windows; verify under both Wayland and X11 sessions; confirm the window can still be resized from edges (if not, note for a `startResizeDragging` follow-up per the spec's Risks).

- [ ] **Step 3: Record results**

Note any inset/resize adjustments needed; if `MAC_TRAFFIC_LIGHT_INSET` changed, re-run `bun test src/titlebarChrome.test.ts` and commit the tweak.

---

## Self-Review

- **Spec coverage:** §1 config → Task 1; §2 components → Tasks 2 (`titlebarChrome`), 4 (`windowControls`), 5 (`TitleBar`); §3 drag region → Task 3 + Task 6 step 2; §4 permissions/Linux → Task 1 (perms) + Task 7 (Linux test); §5 testing → Tasks 2/3 (unit), 6 (typecheck + suite), 7 (manual per-OS). Phasing preserved: Tasks 1 + 3 + inset = Phase 1; Tasks 4–6 = Phase 2; Snap Layouts explicitly deferred.
- **Placeholder scan:** no TBD/TODO; all code steps show full code. Task 6 steps 3 & 4 contain conditional "verify the existing name" notes with concrete fallbacks (not placeholders — they guard against drift in symbols this plan doesn't own).
- **Type consistency:** `titlebarChrome(isMac): { showControls, leftInset }` and `MAC_TRAFFIC_LIGHT_INSET` consistent across Tasks 2/5/7; `DRAG_PROPS`/`NO_DRAG_PROPS`/`injectDragRegionStyles` consistent across Tasks 3/5/6; `windowControls` exports (`minimizeWindow`/`toggleMaximizeWindow`/`closeWindow`/`onMaximizeChange`) consistent across Tasks 4/5; `TitleBarProps` status union matches the mapping in Task 6 step 3.
