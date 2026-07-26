# Mobile Terminal Selection Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a frozen, natively selectable terminal transcript from the mobile overflow menu.

**Architecture:** Reuse the existing `SelectionView` and `openSelectionView` snapshot path. Replace the redundant search-specific menu action; no new component, state, dependency, or gesture is introduced.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Bun

## Global Constraints

- The transcript is captured once when the action is pressed.
- Live terminal output does not update the open selection view.
- The filter field remains available inside `SelectionView`.
- Do not add another menu item, viewer, gesture, or live-update mode.

---

### Task 1: Wire the existing selection view into the overflow menu

**Files:**
- Modify: `apps/mobile/src/OverflowMenu.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: `openSelectionView(): void`, which snapshots the active `TerminalEngine`.
- Produces: `OverflowMenu` prop `onSelectText: () => void`.

- [x] **Step 1: Establish the current verification baseline**

Run:

```bash
bun --cwd apps/mobile test
bun --cwd apps/mobile typecheck
```

Expected: 175 tests pass and TypeScript exits successfully.

- [x] **Step 2: Rename the overflow action and callback**

In `OverflowMenu.tsx`, replace `onSearch` with `onSelectText` in the prop list
and type, then replace the search row with:

```tsx
<TouchableOpacity style={styles.menuRow} onPress={onSelectText}>
  <Feather name="copy" size={16} color={theme.colors.text} />
  <Text style={styles.menuRowText}>Select terminal text</Text>
</TouchableOpacity>
```

- [x] **Step 3: Route the menu action to the frozen snapshot path**

In `TerminalScreen.tsx`, replace:

```tsx
onSearch={openSearch}
```

with:

```tsx
onSelectText={openSelectionView}
```

Remove `openSearch` from the values destructured from `useTetherApp`.

- [x] **Step 4: Make opening behavior self-contained**

Delete the redundant `openSearch` function in `useTetherApp.tsx`. Update
`openSelectionView` so every entry point closes the menu, clears an old filter,
captures one snapshot, and opens the existing view:

```tsx
const openSelectionView = () => {
  const snapshot = entryFor(activeIdRef.current).term.getSnapshot();
  if (!snapshotText(snapshot)) return;
  setMenuOpen(false);
  setSearchQuery('');
  setScreen(snapshot);
  setSelectionViewOpen(true);
};
```

Remove `openSearch` from the hook return object.

- [x] **Step 5: Verify behavior and regressions**

Run:

```bash
bun --cwd apps/mobile test
bun run lint
git diff --check
```

Expected: all tests pass, lint/typecheck exits successfully, and no whitespace
errors are reported. The frozen-snapshot guarantee is structural: `setScreen`
is called only when opening the selection view, never from the streaming output
path.

- [x] **Step 6: Commit**

```bash
git add apps/mobile/src/OverflowMenu.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/useTetherApp.tsx
git commit -m "fix(mobile): restore transcript selection menu"
```
