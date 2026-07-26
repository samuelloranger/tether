# Application UI/UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tether’s mobile and desktop-adaptive shell clearer, consistent, accessible, and purposefully animated while preserving its Catppuccin terminal-first experience.

**Architecture:** Introduce a small dependency-free motion policy for native-driver timing and reduced-motion behavior. Existing presentational components consume the policy plus shared interaction metrics; `useTetherApp`, the xterm renderer, terminal dimensions, and all transport/session contracts remain unchanged.

**Tech Stack:** React 19.2, React Native 0.86 Animated API, Expo 57, TypeScript, Bun test.

## Global Constraints

- Preserve Catppuccin palettes, semantic colors, and terminal-first hierarchy.
- Do not modify `TerminalEngine`, `TerminalView`, terminal renderer code, WebSocket behavior, server APIs, or session semantics.
- Add no dependencies; use built-in `Animated` and `AccessibilityInfo`.
- Animate only opacity and transforms. Never animate terminal layout, output, width, height, margins, padding, diff text, or file syntax content.
- Reduced-motion mode changes UI state immediately.
- Use 120ms feedback, 220–240ms entrances, and 160ms exits.
- Keep labels, focus/selected states, and 44pt targets on every interactive control.

---

## File structure

- `apps/mobile/src/motion.ts` — duration policy for feedback and overlay transitions.
- `apps/mobile/src/motion.test.ts` — unit coverage for motion decisions.
- `apps/mobile/src/interaction.ts` — touch-target and surface-radius metrics.
- `apps/mobile/src/interaction.test.ts` — unit coverage for interaction metrics.
- `apps/mobile/src/ConfigScreen.tsx`, `ConnectionBanner.tsx` — setup and recovery clarity.
- `apps/mobile/src/SessionDrawer.tsx`, `DesktopSessionNavigator.tsx` — shared session-navigation hierarchy.
- `apps/mobile/src/OverflowMenu.tsx`, `SessionModals.tsx` — coherent overlay interactions.
- `apps/mobile/src/TerminalScreen.tsx`, `UtilityBar.tsx`, `FileViewer.tsx`, `DiffView.tsx` — terminal-adjacent integration.

## Tasks

### Task 1: Add motion and interaction foundations

**Files:**
- Create: `apps/mobile/src/motion.ts`
- Create: `apps/mobile/src/motion.test.ts`
- Create: `apps/mobile/src/interaction.ts`
- Create: `apps/mobile/src/interaction.test.ts`

**Interfaces:**
- Produces `motionSpec(kind, reduceMotion)` for presentational transitions.
- Produces `HIT_SLOP`, `MIN_TOUCH_TARGET`, and `SURFACE_RADIUS` for UI controls.

- [ ] **Step 1: Write failing tests**

```ts
// apps/mobile/src/motion.test.ts
import { motionSpec } from './motion';

test('uses a quick native-driver drawer exit', () => {
  expect(motionSpec('drawerExit', false)).toEqual({ duration: 160, useNativeDriver: true });
});

test('removes nonessential motion when reduced motion is enabled', () => {
  expect(motionSpec('modalEnter', true)).toEqual({ duration: 0, useNativeDriver: true });
});
```

```ts
// apps/mobile/src/interaction.test.ts
import { HIT_SLOP, MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';

test('exports the shared accessible interaction metrics', () => {
  expect(HIT_SLOP).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
  expect(MIN_TOUCH_TARGET).toBe(44);
  expect(SURFACE_RADIUS).toEqual({ control: 8, panel: 12, hero: 16 });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `bun --cwd apps/mobile test src/motion.test.ts src/interaction.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the modules**

```ts
// apps/mobile/src/motion.ts
export type MotionKind = 'feedback' | 'drawerEnter' | 'drawerExit' | 'modalEnter' | 'modalExit';

const DURATIONS: Record<MotionKind, number> = {
  feedback: 120,
  drawerEnter: 240,
  drawerExit: 160,
  modalEnter: 220,
  modalExit: 160,
};

export function motionSpec(kind: MotionKind, reduceMotion: boolean) {
  return { duration: reduceMotion ? 0 : DURATIONS[kind], useNativeDriver: true as const };
}
```

```ts
// apps/mobile/src/interaction.ts
export const HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 } as const;
export const MIN_TOUCH_TARGET = 44;
export const SURFACE_RADIUS = { control: 8, panel: 12, hero: 16 } as const;
```

- [ ] **Step 4: Verify the foundation**

Run: `bun --cwd apps/mobile test src/motion.test.ts src/interaction.test.ts && bun --cwd apps/mobile typecheck`
Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/motion.ts apps/mobile/src/motion.test.ts apps/mobile/src/interaction.ts apps/mobile/src/interaction.test.ts
git commit -m "feat(ui): add motion and interaction policy"
```

### Task 2: Polish setup and reconnect recovery

**Files:**
- Modify: `apps/mobile/src/ConfigScreen.tsx:57-277`
- Modify: `apps/mobile/src/ConnectionBanner.tsx:1-65`
- Modify: `apps/mobile/src/motion.test.ts`
- Test: `apps/mobile/src/appConfig.test.ts`

**Interfaces:**
- Consumes Task 1 exports.
- Preserves all `ConfigScreen` and `ConnectionBanner` props.

- [ ] **Step 1: Add a failing state-mapping test**

```ts
// add to apps/mobile/src/motion.test.ts
import { connectionPresentation } from './ConnectionBanner';

test('keeps recovery copy specific to the actual state', () => {
  expect(connectionPresentation('auth-failed', false)).toEqual({ label: 'Wrong password.', tone: 'danger' });
  expect(connectionPresentation('disconnected', true)).toEqual({
    label: 'Reconnecting… (session kept running on the server)',
    tone: 'warning',
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun --cwd apps/mobile test src/motion.test.ts`
Expected: FAIL because `connectionPresentation` is not exported.

- [ ] **Step 3: Implement recovery and setup polish**

Add this exported helper to `ConnectionBanner.tsx` and select `theme.colors.danger` or `theme.colors.warning` from its `tone` value:

```ts
export function connectionPresentation(status: Status, hasConnected: boolean) {
  if (status === 'auth-failed') return { label: 'Wrong password.', tone: 'danger' as const };
  if (hasConnected) return { label: 'Reconnecting… (session kept running on the server)', tone: 'warning' as const };
  return { label: 'Connecting…', tone: 'warning' as const };
}
```

Animate only the banner’s opacity/translateY with `motionSpec('feedback', reduceMotion)`; retain its absolute overlay so it cannot resize the terminal. In `ConfigScreen.tsx`, use `SURFACE_RADIUS.hero` for the form card, `MIN_TOUCH_TARGET` for the primary control, `accessibilityRole="button"`, and `accessibilityState={{ disabled: testStatus.kind === 'testing' }}`. Show a visible `ActivityIndicator` beside `Testing…` while the callback is in flight.

- [ ] **Step 4: Verify behavior**

Run: `bun --cwd apps/mobile test src/motion.test.ts src/appConfig.test.ts && bun --cwd apps/mobile typecheck`
Expected: tests pass; setup callbacks and connection-banner props remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/ConfigScreen.tsx apps/mobile/src/ConnectionBanner.tsx apps/mobile/src/motion.test.ts
git commit -m "feat(ui): polish setup and reconnect states"
```

### Task 3: Normalize sessions, drawers, and desktop navigation

**Files:**
- Modify: `apps/mobile/src/SessionDrawer.tsx:64-327`
- Modify: `apps/mobile/src/DesktopSessionNavigator.tsx:12-406`
- Test: `apps/mobile/src/sessionDrawer.test.ts`
- Test: `apps/mobile/src/desktopNavigation.test.ts`
- Test: `apps/mobile/src/activity.test.ts`

**Interfaces:**
- Consumes Task 1 exports.
- Preserves `SessionDrawerProps` and `DesktopSessionNavigatorProps` including all select/new/kill/preview/settings callbacks.

- [ ] **Step 1: Add the activity-label assertion**

```ts
// add to apps/mobile/src/activity.test.ts
import { activityLabel } from './activity';

test('describes a waiting session as needing input', () => {
  expect(activityLabel('waiting')).toBe('needs input');
});
```

- [ ] **Step 2: Run the navigation baseline**

Run: `bun --cwd apps/mobile test src/sessionDrawer.test.ts src/desktopNavigation.test.ts src/activity.test.ts`
Expected: PASS before presentation changes.

- [ ] **Step 3: Implement navigation polish**

In `SessionDrawer.tsx`, replace local 240/160 duration literals with `motionSpec('drawerEnter', reduceMotion.current)` and `motionSpec('drawerExit', reduceMotion.current)`. Keep the existing translateX/scrim lifecycle, including mounting before entrance and unmounting after a completed exit. Apply `MIN_TOUCH_TARGET` and `HIT_SLOP` to rows, settings, new, and kill actions.

In both renderers, make accessible labels include `activityLabel(dotKey)`; keep `accessibilityState={{ selected: active }}`. Use `selected` for current rows, reserve `danger` for kill/close, and use the same 8pt control radius and 44pt target across mobile and desktop.

- [ ] **Step 4: Verify navigation**

Run: `bun --cwd apps/mobile test src/sessionDrawer.test.ts src/desktopNavigation.test.ts src/activity.test.ts && bun --cwd apps/mobile typecheck`
Expected: all tests pass with no changed session or navigation-mode API.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/SessionDrawer.tsx apps/mobile/src/DesktopSessionNavigator.tsx apps/mobile/src/activity.test.ts
git commit -m "feat(ui): unify session navigation polish"
```

### Task 4: Refine menus and modal interactions

**Files:**
- Modify: `apps/mobile/src/OverflowMenu.tsx:10-275`
- Modify: `apps/mobile/src/SessionModals.tsx:28-298`
- Modify: `apps/mobile/src/appTheme.test.ts`

**Interfaces:**
- Consumes Task 1 exports.
- Preserves every menu and modal prop signature and all existing close paths.

- [ ] **Step 1: Add semantic-surface coverage**

```ts
// add to apps/mobile/src/appTheme.test.ts
import { APP_THEMES } from './appTheme';

test('every theme separates interactive surface roles', () => {
  for (const theme of Object.values(APP_THEMES)) {
    expect(theme.colors.surface).not.toBe(theme.colors.input);
    expect(theme.colors.accent).not.toBe(theme.colors.danger);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `bun --cwd apps/mobile test src/appTheme.test.ts`
Expected: PASS, confirming no palette change is needed.

- [ ] **Step 3: Implement coherent overlays**

Retain native `Modal` boundaries and callbacks. Add opacity/scale animation to menu/modal panels only, driven by `motionSpec('modalEnter', reduceMotion)` and `motionSpec('modalExit', reduceMotion)`; set the final state immediately under reduced motion. Apply `SURFACE_RADIUS.panel`, `MIN_TOUCH_TARGET`, and `HIT_SLOP` to all menu rows, theme/font choices, snippet operations, and modal buttons.

Group terminal actions, appearance/navigation controls, and destructive restart into visibly separated sections. Keep existing labels. Use `theme.colors.danger` only for destructive actions, and preserve backdrop and platform back-button close behavior.

- [ ] **Step 4: Verify overlays**

Run: `bun --cwd apps/mobile test src/appTheme.test.ts && bun --cwd apps/mobile typecheck`
Expected: typecheck passes; Escape/backdrop/back-button routes still call the existing `onClose` functions.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/OverflowMenu.tsx apps/mobile/src/SessionModals.tsx apps/mobile/src/appTheme.test.ts
git commit -m "feat(ui): refine terminal menus and modals"
```

### Task 5: Align terminal-adjacent surfaces and complete validation

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx:311-708`
- Modify: `apps/mobile/src/UtilityBar.tsx`
- Modify: `apps/mobile/src/FileViewer.tsx`
- Modify: `apps/mobile/src/DiffView.tsx`
- Test: `apps/mobile/src/fileViewer.test.ts`
- Test: `apps/mobile/src/diffModel.test.ts`
- Test: `apps/mobile/src/changeBanner.test.ts`

**Interfaces:**
- Consumes Task 1 metrics.
- Preserves `TerminalViewProps`, file/diff models, and all `TerminalScreen` callbacks.

- [ ] **Step 1: Run the regression baseline**

Run: `bun --cwd apps/mobile test src/fileViewer.test.ts src/diffModel.test.ts src/changeBanner.test.ts`
Expected: PASS; any failure blocks visual work until resolved.

- [ ] **Step 2: Implement terminal-adjacent polish**

Keep `TerminalView`, the hidden input, terminal-area structure, and connection-banner absolute overlay unchanged. Apply `MIN_TOUCH_TARGET` to header/menu actions; status badges pair visible text with their semantic dot or spinner and get only brief feedback animation.

Align utility-bar controls, file/diff headers, back/close controls, loading affordances, empty/error panels, selected items, and destructive git actions to the shared surface hierarchy. Do not animate terminal output, renderer size, file code, diff text, or image dimensions.

- [ ] **Step 3: Run focused and complete automated verification**

Run: `bun --cwd apps/mobile test src/fileViewer.test.ts src/diffModel.test.ts src/changeBanner.test.ts && bun --cwd apps/mobile test && bun --cwd apps/mobile typecheck`
Expected: focused tests and full mobile suite pass; TypeScript exits 0.

- [ ] **Step 4: Perform visual accessibility verification**

Run: `bun --cwd apps/mobile start`

Check narrow mobile, intermediate tablet, and desktop/Tauri layouts:

```text
1. Connect, reconnect, and use a wrong password; verify state-specific copy and the Edit route.
2. Open, select, close, and create sessions/previews; verify drawer continuity and readable activity labels.
3. Open overflow actions, appearance, rename, and snippets; verify 44pt controls and backdrop/back close.
4. Open file and diff review then return; verify the original terminal stays visible and does not resize or flicker.
5. Turn on OS reduced motion; drawers, menus, and modals must change state immediately.
6. Use desktop keyboard focus and mobile touch; verify visible focus, labels, selected state, and separate destructive actions.
```

- [ ] **Step 5: Inspect scope and commit**

Run: `git diff main...HEAD -- apps/mobile`
Expected: only UI policy, presentational components, and focused tests change; no terminal engine, renderer, transport, or server file changes.

```bash
git add apps/mobile
git commit -m "feat(ui): polish terminal workspace surfaces"
```
