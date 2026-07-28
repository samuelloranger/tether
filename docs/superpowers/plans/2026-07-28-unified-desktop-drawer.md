# Unified Desktop Session Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use `SessionDrawer` as the single session navigator, docked on wide desktop and overlaid on compact desktop/mobile, without the Workspace header or obsolete desktop navigation modes.

**Architecture:** `TerminalScreen` renders one `SessionDrawer` instance and switches only its `docked` and `visible` presentation props at the existing 720px content breakpoint. `SessionDrawer` continues to own host/session/preview navigation; the separate `DesktopSessionNavigator` and persisted sidebar/hover/tabs preference are removed.

**Tech Stack:** React 19, React Native 0.86, Expo 57, TypeScript, Jest + React Native Testing Library, Bun tests, Tauri desktop shell.

## Global Constraints

- Keep `MIN_DESKTOP_LAYOUT_WIDTH` at `720`.
- Keep `PANEL_W` at `264`.
- Wide desktop keeps the drawer permanently visible.
- Compact desktop and native mobile keep the animated overlay drawer.
- Remove only the top-level Workspace label and global Settings gear; retain every per-host settings action.
- Do not change host, session, preview, or server contracts.
- Do not add dependencies, fonts, colors, or animations.

---

### Task 1: Make SessionDrawer the single responsive navigator

**Files:**
- Modify: `apps/mobile/src/SessionDrawer.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/__tests__/SessionDrawer.spec.tsx`
- Create: `apps/mobile/__tests__/DesktopTerminalDrawer.spec.tsx`

**Interfaces:**
- Consumes: `SessionDrawer` props for hosts, health, sessions, previews, selection, host actions, and `docked?: boolean`.
- Produces: one responsive `SessionDrawer` rendering path where `docked={desktopUi}` and `visible={desktopUi || drawerOpen}`.

- [ ] **Step 1: Add failing drawer hierarchy coverage**

Extend `SessionDrawer.spec.tsx` with a shared fixture that renders both `docked` and overlay variants. Assert both variants expose the same host section, session, Add host, New terminal, and per-host settings control. Assert neither renders `Workspace` nor a global `Settings` accessibility label:

```tsx
expect(view.queryByText('Workspace')).toBeNull();
expect(view.queryByLabelText('Settings')).toBeNull();
expect(view.getByLabelText('Server settings for Studio')).toBeTruthy();
expect(view.getByLabelText('Add host')).toBeTruthy();
expect(view.getByLabelText('New terminal')).toBeTruthy();
```

- [ ] **Step 2: Run the drawer test and verify it fails**

Run:

```bash
cd apps/mobile
bun run test:ui --runInBand __tests__/SessionDrawer.spec.tsx
```

Expected: FAIL because `Workspace` and the global Settings button still render.

- [ ] **Step 3: Remove the drawer-level header**

In `SessionDrawer.tsx`:

- Remove the required `onSettings: () => void` prop.
- Remove the `Workspace` header block and its terminal/settings icons.
- Remove the unused `header`, `settingsBtn`, and `title` styles.
- Preserve `onHostSettings` and the per-host settings buttons.
- Change docked top spacing from `paddingTop: 12` to a small content inset (`paddingTop: 8`) so the first host section does not collide with the title bar.

- [ ] **Step 4: Add failing desktop integration coverage**

Create `DesktopTerminalDrawer.spec.tsx` by following the established TerminalScreen component-test mocks. Render a desktop-width `TerminalScreen` and assert:

```tsx
expect(view.getByLabelText('Studio host section')).toBeTruthy();
expect(view.queryByText('Workspace')).toBeNull();
expect(view.queryByLabelText('Open terminal list')).toBeNull();
```

Then switch the mocked window width below `720` and assert the compact header exposes `Open terminal list`, while the drawer content is absent until that button is pressed.

- [ ] **Step 5: Run the desktop integration test and verify it fails**

Run:

```bash
cd apps/mobile
bun run test:ui --runInBand __tests__/DesktopTerminalDrawer.spec.tsx
```

Expected: FAIL because wide desktop still renders `DesktopSessionNavigator`.

- [ ] **Step 6: Route both breakpoints through SessionDrawer**

In `TerminalScreen.tsx`:

- Remove the `DesktopSessionNavigator` import.
- Make `styles.terminalBody` a row whenever `desktopUi` is true.
- Render one `SessionDrawer` as the first child of `terminalBody` with:

```tsx
visible={desktopUi || drawerOpen}
docked={desktopUi}
```

- Pass the existing multi-host `profiles`, `healthByHost`, `drawerSessions`, host-qualified `onSelect`, retry, password, host settings, preview, Add host, New terminal, and kill callbacks.
- Keep `onClose={() => setDrawerOpen(false)}` for overlay mode.
- Remove the duplicate mobile-only `SessionDrawer` block.
- Keep the compact header trigger unchanged.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd apps/mobile
bun run test:ui --runInBand __tests__/SessionDrawer.spec.tsx __tests__/DesktopTerminalDrawer.spec.tsx __tests__/terminalInput.spec.tsx
bun run typecheck
```

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit the unified navigator**

```bash
git add apps/mobile/src/SessionDrawer.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/__tests__/SessionDrawer.spec.tsx apps/mobile/__tests__/DesktopTerminalDrawer.spec.tsx
git commit -m "refactor(desktop): unify session drawer"
```

---

### Task 2: Remove obsolete desktop navigation modes

**Files:**
- Delete: `apps/mobile/src/DesktopSessionNavigator.tsx`
- Modify: `apps/mobile/src/OverflowMenu.tsx`
- Modify: `apps/mobile/src/desktopNavigation.ts`
- Modify: `apps/mobile/src/desktopNavigation.test.ts`
- Modify: `apps/mobile/src/tether/useAppPreferences.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Create: `apps/mobile/__tests__/OverflowMenu.spec.tsx`

**Interfaces:**
- Consumes: `PANEL_W`, `isRecentlyActive`, and `sessionActivity` from `desktopNavigation.ts`.
- Produces: no `DesktopNavigationMode`, `desktopNavigationMode`, `selectDesktopNavigationMode`, or overflow-menu navigation selector.

- [ ] **Step 1: Add a failing OverflowMenu regression assertion**

Create `OverflowMenu.spec.tsx`, render the real `OverflowMenu` with its required callbacks, open the menu through its accessibility-labelled trigger, and assert:

```tsx
expect(view.queryByText('Navigation')).toBeNull();
expect(view.queryByLabelText('Navigation: Sidebar')).toBeNull();
expect(view.queryByLabelText('Navigation: On hover')).toBeNull();
expect(view.queryByLabelText('Navigation: Tabs')).toBeNull();
```

Run:

```bash
cd apps/mobile
bun run test:ui --runInBand __tests__/OverflowMenu.spec.tsx
```

Expected: FAIL because the Navigation section and its three choices still render.

- [ ] **Step 2: Remove the navigation selector and preference plumbing**

- Delete the `DesktopNavigationMode` import and `desktopNavigationMode` / `onDesktopNavigationMode` props and markup from `OverflowMenu.tsx`.
- Remove those props at the `TerminalScreen` call site.
- Remove `desktopNavigationMode` and `selectDesktopNavigationMode` from `useTetherApp` destructuring and return value.
- Remove the navigation state, AsyncStorage read/write effects, and desktop imports from `useAppPreferences.ts`; retain snippet persistence unchanged.

- [ ] **Step 3: Reduce desktopNavigation.ts to shared drawer utilities**

Keep:

```ts
export const PANEL_W = 264;
export function isRecentlyActive(ts: string | null): boolean;
export function sessionActivity(
  session: { status: 'running' | 'stopped'; last_output_at: string | null },
  active: boolean,
): 'stopped' | 'live' | 'idle';
```

Remove the mode type, default, storage key, parser, reserved-width helper, and label helper. Update `desktopNavigation.test.ts` to cover only activity behavior.

- [ ] **Step 4: Delete DesktopSessionNavigator**

Delete `apps/mobile/src/DesktopSessionNavigator.tsx` after confirming no imports remain:

```bash
rg -n "DesktopSessionNavigator|DesktopNavigationMode|desktopNavigationMode|selectDesktopNavigationMode|DESKTOP_NAVIGATION_STORAGE_KEY" apps/mobile
```

Expected: no production-code matches.

- [ ] **Step 5: Run focused and complete verification**

Run:

```bash
cd apps/mobile
bun test src
bun run test:ui --runInBand
bun run typecheck
cd ../..
bun run lint
cd apps/mobile
bun run build:web
```

Expected: pure tests, component tests, typechecks, lint, and web export all pass. Remove Expo's incidental root `packageManager` edit if it is reintroduced by export.

- [ ] **Step 6: Drive the Tauri breakpoint behavior**

Launch:

```bash
cd apps/mobile
DISPLAY=:1 bun run tauri:dev
```

Verify:

1. Wide window: drawer is permanently visible and begins directly with host sections.
2. Resize below `720` CSS pixels: drawer becomes hidden and the compact terminal-list button appears.
3. Open the compact drawer: it contains the same hosts, sessions, previews, Add host, and New terminal controls.
4. Neither presentation contains Workspace or a global drawer gear.
5. Per-host settings gears still open the unified host settings page.

- [ ] **Step 7: Commit cleanup**

```bash
git add apps/mobile/src/OverflowMenu.tsx apps/mobile/src/desktopNavigation.ts apps/mobile/src/desktopNavigation.test.ts apps/mobile/src/tether/useAppPreferences.ts apps/mobile/src/useTetherApp.tsx apps/mobile/__tests__/OverflowMenu.spec.tsx
git add -u apps/mobile/src/DesktopSessionNavigator.tsx
git commit -m "refactor(desktop): remove navigation modes"
```
