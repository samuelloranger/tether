# Configurable Desktop Session Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop users switch between a persistent session sidebar, a left-edge hover sidebar, and top session tabs from the title-bar overflow menu.

**Architecture:** A small `desktopNavigation` module defines the three allowed modes and their width behavior. `useTetherApp` owns and persists the selected desktop mode; `DesktopSessionNavigator` renders all three desktop views from the existing session list and callbacks. `TerminalScreen` places the navigator and `OverflowMenu` selects the mode; mobile remains on `SessionDrawer` and never reads the preference.

**Tech Stack:** TypeScript, React 19, React Native Web, Expo AsyncStorage, Bun test, Tauri desktop shell.

## Global Constraints

- Desktop only means `Platform.OS === 'web'`; preserve all mobile navigation behavior.
- Valid persisted values are exactly `sidebar`, `hover`, and `tabs`; default and invalid values resolve to `sidebar`.
- Use existing AsyncStorage and installed dependencies only; do not add a UI or test dependency.
- The sidebar width remains 264px and only `sidebar` reserves it from the terminal grid.
- Hover opens on pointer entry and closes immediately when the pointer leaves the trigger-and-panel region.
- Keep the existing native destructive confirmation before a session is killed.

---

## File structure

- Create: `apps/mobile/src/desktopNavigation.ts` — desktop navigation-mode type, validation, storage key, default, and pane-width helper.
- Create: `apps/mobile/src/desktopNavigation.test.ts` — Bun tests for mode parsing and reserved-width behavior.
- Create: `apps/mobile/src/DesktopSessionNavigator.tsx` — the single desktop UI renderer for persistent sidebar, hover sidebar, and tabs.
- Modify: `apps/mobile/src/useTetherApp.tsx` — load, persist, return, and use the selected desktop mode for terminal dimensions.
- Modify: `apps/mobile/src/TerminalScreen.tsx` — render the desktop navigator and pass the current mode to the overflow menu.
- Modify: `apps/mobile/src/OverflowMenu.tsx` — show the desktop-only three-button Navigation section and active state.

### Task 1: Define and persist the navigation-mode contract

**Files:**
- Create: `apps/mobile/src/desktopNavigation.ts`
- Create: `apps/mobile/src/desktopNavigation.test.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Produces: `DesktopNavigationMode`, `DEFAULT_DESKTOP_NAVIGATION_MODE`, `DESKTOP_NAVIGATION_STORAGE_KEY`, `parseDesktopNavigationMode(value)`, and `reservedNavigationWidth(mode)`.
- Consumes: `PANEL_W` from `apps/mobile/src/SessionDrawer.tsx` only inside `useTetherApp.tsx` for its existing sidebar-width calculation.
- Produces for later tasks: `desktopNavigationMode: DesktopNavigationMode` and `setDesktopNavigationMode(mode: DesktopNavigationMode): void` in `useTetherApp()`.

- [ ] **Step 1: Write the failing mode-contract test**

Create `apps/mobile/src/desktopNavigation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DESKTOP_NAVIGATION_MODE,
  parseDesktopNavigationMode,
  reservedNavigationWidth,
} from './desktopNavigation';

describe('desktop navigation mode', () => {
  it('accepts only the three persisted modes and defaults malformed values', () => {
    expect(parseDesktopNavigationMode('sidebar')).toBe('sidebar');
    expect(parseDesktopNavigationMode('hover')).toBe('hover');
    expect(parseDesktopNavigationMode('tabs')).toBe('tabs');
    expect(parseDesktopNavigationMode(null)).toBe(DEFAULT_DESKTOP_NAVIGATION_MODE);
    expect(parseDesktopNavigationMode('drawer')).toBe(DEFAULT_DESKTOP_NAVIGATION_MODE);
  });

  it('reserves pane width only for the persistent sidebar', () => {
    expect(reservedNavigationWidth('sidebar')).toBe(264);
    expect(reservedNavigationWidth('hover')).toBe(0);
    expect(reservedNavigationWidth('tabs')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/mobile && bun test src/desktopNavigation.test.ts`

Expected: FAIL because `./desktopNavigation` does not exist.

- [ ] **Step 3: Add the minimal mode module and hook state**

Create `apps/mobile/src/desktopNavigation.ts`:

```ts
export type DesktopNavigationMode = 'sidebar' | 'hover' | 'tabs';

export const DEFAULT_DESKTOP_NAVIGATION_MODE: DesktopNavigationMode = 'sidebar';
export const DESKTOP_NAVIGATION_STORAGE_KEY = 'tether_desktop_navigation_mode';

export function parseDesktopNavigationMode(value: string | null): DesktopNavigationMode {
  return value === 'hover' || value === 'tabs' || value === 'sidebar'
    ? value
    : DEFAULT_DESKTOP_NAVIGATION_MODE;
}

export function reservedNavigationWidth(mode: DesktopNavigationMode): number {
  return mode === 'sidebar' ? 264 : 0;
}
```

In `apps/mobile/src/useTetherApp.tsx`, import the module, initialize state to `DEFAULT_DESKTOP_NAVIGATION_MODE`, and add a desktop-only mount effect:

```ts
useEffect(() => {
  if (!isDesktop) return;
  AsyncStorage.getItem(DESKTOP_NAVIGATION_STORAGE_KEY)
    .then((value) => setDesktopNavigationMode(parseDesktopNavigationMode(value)))
    .catch(() => {});
}, []);

const selectDesktopNavigationMode = (mode: DesktopNavigationMode) => {
  setDesktopNavigationMode(mode);
  if (isDesktop) AsyncStorage.setItem(DESKTOP_NAVIGATION_STORAGE_KEY, mode).catch(() => {});
};
```

Replace the unconditional desktop `PANEL_W` subtraction with `reservedNavigationWidth(desktopNavigationMode)`, and return `desktopNavigationMode` plus `selectDesktopNavigationMode` from the hook.

- [ ] **Step 4: Run the mode test and TypeScript check**

Run: `cd apps/mobile && bun test src/desktopNavigation.test.ts && bun run lint`

Expected: both commands pass; invalid storage remains sidebar and only sidebar reserves 264px.

- [ ] **Step 5: Commit the contract and persistence work**

```bash
git add apps/mobile/src/desktopNavigation.ts apps/mobile/src/desktopNavigation.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "feat(desktop): persist navigation mode"
```

### Task 2: Build the shared desktop navigator

**Files:**
- Create: `apps/mobile/src/DesktopSessionNavigator.tsx`

**Interfaces:**
- Consumes: `DesktopNavigationMode` from `desktopNavigation.ts` and `DrawerSession` from `SessionDrawer.tsx`.
- Produces: `DesktopSessionNavigator(props)` with `mode`, `sessions`, `activeId`, `onSelect`, `onNew`, `onKill`, and `onSettings` props.
- Consumes from Task 1: selected mode is always one of the three valid union members.
- Produces for Task 3: a desktop-only element that includes its own hover visibility and does not reserve layout width except in `sidebar` mode.

- [ ] **Step 1: Implement the one shared desktop renderer**

Create `apps/mobile/src/DesktopSessionNavigator.tsx`. It must render the same session collection through a shared `panel` variable for both sidebar forms, and render the same collection as tabs for tab mode:

```tsx
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { confirmAction } from './dialog';
import type { DrawerSession } from './SessionDrawer';
import type { DesktopNavigationMode } from './desktopNavigation';

export interface DesktopSessionNavigatorProps {
  mode: DesktopNavigationMode;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onSettings: () => void;
}

const dotColor = (session: DrawerSession, active: boolean) =>
  session.status === 'stopped' ? '#64748b' : active ? '#22c55e' : '#334155';

export function DesktopSessionNavigator({ mode, sessions, activeId, onSelect, onNew, onKill, onSettings }: DesktopSessionNavigatorProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const kill = async (id: string) => {
    if (await confirmAction('Kill terminal', 'This deletes the process and its logs.', { confirmLabel: 'Kill', destructive: true })) onKill(id);
  };
  const sessionRows = sessions.map((session) => {
    const active = session.id === activeId;
    const label = session.name || session.id;
    return (
      <View key={session.id} style={[styles.row, active && styles.rowActive]}>
        <TouchableOpacity style={styles.rowMain} onPress={() => onSelect(session.id)} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`Terminal ${label}`}>
          <View style={[styles.dot, { backgroundColor: dotColor(session, active) }]} />
          <Text style={styles.name}>{label}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void kill(session.id)} accessibilityRole="button" accessibilityLabel={`Kill terminal ${label}`}>
          <Feather name="x" size={16} color="#f87171" />
        </TouchableOpacity>
      </View>
    );
  });
  const panel = (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>Terminals</Text>
        <TouchableOpacity onPress={onSettings} accessibilityRole="button" accessibilityLabel="Settings"><Feather name="settings" size={15} color="#94a3b8" /></TouchableOpacity>
      </View>
      <ScrollView style={styles.list}>{sessionRows}</ScrollView>
      <TouchableOpacity style={styles.newButton} onPress={onNew} accessibilityRole="button" accessibilityLabel="New terminal"><Text style={styles.newButtonText}>New terminal</Text></TouchableOpacity>
    </View>
  );
  if (mode === 'tabs') return <ScrollView horizontal style={styles.tabs}>{sessions.map((session) => {
    const active = session.id === activeId;
    const label = session.name || session.id;
    return <View key={session.id} style={[styles.tab, active && styles.tabActive]}><TouchableOpacity onPress={() => onSelect(session.id)} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`Terminal ${label}`}><Text style={styles.tabText}>{label}</Text></TouchableOpacity><TouchableOpacity onPress={() => void kill(session.id)} accessibilityRole="button" accessibilityLabel={`Kill terminal ${label}`}><Feather name="x" size={14} color="#f87171" /></TouchableOpacity></View>;
  })}</ScrollView>;
  if (mode === 'sidebar') return <View style={styles.sidebar}>{panel}</View>;
  return <View style={styles.hoverRegion} onMouseEnter={() => setHoverOpen(true)} onMouseLeave={() => setHoverOpen(false)}><View style={styles.hoverTarget} />{hoverOpen ? <View style={styles.hoverPanel}>{panel}</View> : null}</View>;
}

const styles = StyleSheet.create({
  sidebar: { width: 264 }, hoverRegion: { position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 1 }, hoverTarget: { width: 12, flex: 1 }, hoverPanel: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 264 }, panel: { flex: 1, backgroundColor: '#0b0f19' }, header: { flexDirection: 'row', justifyContent: 'space-between', padding: 14 }, title: { color: '#e2e8f0', fontWeight: '700' }, list: { flex: 1 }, row: { flexDirection: 'row', alignItems: 'center', padding: 12 }, rowActive: { backgroundColor: 'rgba(99, 102, 241, 0.14)' }, rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' }, dot: { width: 7, height: 7, borderRadius: 4, marginRight: 8 }, name: { color: '#cbd5e1' }, newButton: { margin: 12, padding: 10, backgroundColor: '#4f46e5', borderRadius: 6 }, newButtonText: { color: '#fff', textAlign: 'center', fontWeight: '700' }, tabs: { flexGrow: 0, backgroundColor: '#0b0f19' }, tab: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 }, tabActive: { borderBottomWidth: 2, borderBottomColor: '#818cf8' }, tabText: { color: '#cbd5e1' },
});
```

The hover target and panel are children of the same `hoverRegion`, so crossing from trigger to panel does not emit a leave. Keep mobile `SessionDrawer` unchanged.

- [ ] **Step 2: Run a static and direct component smoke check**

Run: `cd apps/mobile && bun run lint`

Expected: PASS. Then start `bun run tauri:dev`, use the existing persistent sidebar path, and confirm the same session list can select a session, create a session, open Settings, and request kill confirmation before continuing.

- [ ] **Step 3: Commit the desktop navigator**

```bash
git add apps/mobile/src/DesktopSessionNavigator.tsx
git commit -m "feat(desktop): add shared session navigator"
```

### Task 3: Wire layout switching and the three-button overflow selector

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/OverflowMenu.tsx`

**Interfaces:**
- Consumes: `DesktopSessionNavigator` from Task 2.
- Consumes: `desktopNavigationMode` and `selectDesktopNavigationMode` from `useTetherApp` in Task 1.
- Produces: immediate desktop layout switching and an active, persistent menu selector.

- [ ] **Step 1: Extend the overflow-menu prop contract first**

In `apps/mobile/src/OverflowMenu.tsx`, add these props to its existing input type:

```tsx
desktopNavigationMode?: DesktopNavigationMode;
onDesktopNavigationMode?: (mode: DesktopNavigationMode) => void;
```

In `TerminalScreen.tsx`, pass the future values:

```tsx
desktopNavigationMode={desktopNavigationMode}
onDesktopNavigationMode={selectDesktopNavigationMode}
```

- [ ] **Step 2: Run TypeScript to verify the missing menu implementation is caught**

Run: `cd apps/mobile && bun run lint`

Expected: FAIL until `TerminalScreen` destructures the values from `app` and the menu component consumes the new props.

- [ ] **Step 3: Replace the desktop sidebar call site and render the selector**

In `TerminalScreen.tsx`, replace the existing desktop `SessionDrawer docked` block with:

```tsx
{isDesktop && (
  <DesktopSessionNavigator
    mode={desktopNavigationMode}
    sessions={drawerSessions}
    activeId={activeId}
    onSelect={switchTo}
    onNew={newTerminal}
    onKill={killActiveOr}
    onSettings={() => setIsConfiguring(true)}
  />
)}
```

Place the tabs branch in normal document flow beneath `TitleBar`; place sidebar in the existing row; place hover as an absolute overlay within the terminal body. Preserve the mobile `SessionDrawer` branch unchanged.

In `OverflowMenu.tsx`, render this desktop-only section before `Check for updates`:

```tsx
{isDesktop && desktopNavigationMode && onDesktopNavigationMode ? (
  <View style={styles.navigationSection}>
    <Text style={styles.navigationLabel}>Navigation</Text>
    <View style={styles.navigationButtons}>
      {(['sidebar', 'hover', 'tabs'] as const).map((mode) => (
        <TouchableOpacity
          key={mode}
          style={[styles.navigationButton, desktopNavigationMode === mode && styles.navigationButtonActive]}
          onPress={() => { onDesktopNavigationMode(mode); onClose(); }}
          accessibilityRole="button"
          accessibilityState={{ selected: desktopNavigationMode === mode }}
          accessibilityLabel={`Navigation: ${mode === 'hover' ? 'On hover' : mode[0].toUpperCase() + mode.slice(1)}`}
        >
          <Text style={styles.navigationButtonText}>{mode === 'hover' ? 'On hover' : mode[0].toUpperCase() + mode.slice(1)}</Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
) : null}
```

Style the buttons as one compact three-button row with a clearly distinct active state; do not create a nested menu or a fourth action.

- [ ] **Step 4: Run automated checks and manual desktop acceptance**

Run: `cd apps/mobile && bun test && bun run lint && bun run build:web`

Expected: all commands pass.

Then run `bun run tauri:dev` and verify:

1. Sidebar is the default and reduces the terminal grid by 264px.
2. Each ⋯ menu button applies immediately, highlights as selected, and remains selected after restarting the app.
3. Hover mode opens at the left edge, stays open while crossing into its panel, and closes immediately when leaving that combined region.
4. Tabs are horizontally scrollable, select the requested session, show status, and require confirmation before close.
5. Switching from sidebar to hover or tabs increases terminal columns; switching back decreases them without mobile regressions.

- [ ] **Step 5: Commit the wired desktop UI**

```bash
git add apps/mobile/src/TerminalScreen.tsx apps/mobile/src/OverflowMenu.tsx
git commit -m "feat(desktop): make session navigation configurable"
```

## Plan self-review

- Spec coverage: Tasks 1–3 cover all three modes, persistence/defaults, immediate three-button selection, desktop-only scope, width resizing, accessibility, destructive confirmation, and error handling. Task 3 lists every manual acceptance condition from the spec.
- Placeholder scan: no unfinished markers, undefined paths, or generic testing instructions remain.
- Type consistency: `DesktopNavigationMode` is defined once in Task 1 and used consistently by the hook, navigator, and overflow menu in Tasks 2–3.
