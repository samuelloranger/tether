# Desktop sidebar pin mode

## Goal

On wide desktop, default the session sidebar to a collapsed overlay (same interaction as mobile/compact). Users who want a permanent sidebar can pin it. The pin preference persists across launches.

## Scope

- Wide desktop only (`desktopLayout(...) === 'desktop'`, i.e. Tauri client and width ≥ 720).
- Reuse existing `SessionDrawer` docked and overlay render paths.
- Persist pin via AsyncStorage (same pattern as snippets / other client prefs).
- Compact desktop and mobile stay overlay-only; no pin control.

## Behavior

### Unpinned (default)

- Sidebar is an overlay: closed until opened, scrim + slide-in.
- Title bar shows a left hamburger that opens the drawer.
- Selecting a session or preview closes the drawer.
- Host-settings from the drawer also closes it (same as mobile).
- Scrim dismiss and existing close callbacks still work.

### Pinned

- Sidebar docks as the permanent inline left column (`docked={true}`).
- Title-bar hamburger is hidden.
- Selecting a session/preview does not close the sidebar.
- Pin preference remains stored when the window shrinks below 720; compact overlay applies while narrow, and docking resumes automatically when the window is wide again.

### Pin control

- Lives inside the drawer header (Feather `pin` / unpin affordance).
- Shown only when the current layout is wide desktop (not on mobile/compact).
- **Pin while open:** set preference true → switch to docked column; overlay/scrim gone; panel stays visible.
- **Unpin while docked:** set preference false → switch to overlay and **close** the drawer so the UI lands in the default collapsed state.

## Persistence

- Key: `tether_sidebar_pinned`
- Values: the strings `"true"` and `"false"`.
- Missing, malformed, or failed reads → `false` (unpinned).
- Failed write does not undo the already-applied in-memory choice.
- Owned by `useAppPreferences`, surfaced through `useTetherApp`.

## Component wiring

| Piece | Responsibility |
|---|---|
| `useAppPreferences` | Load/persist `sidebarPinned` + `setSidebarPinned` / `persistSidebarPinned` |
| `useTetherApp` | Expose preference to the screen |
| `TerminalScreen` | `docked = desktopUi && sidebarPinned`; `visible = docked \|\| drawerOpen`; gate auto-close and TitleBar hamburger on `!docked`; pass pin toggle into drawer |
| `TitleBar` | Optional `onOpenDrawer` → left hamburger; only passed when wide desktop and unpinned |
| `SessionDrawer` | Optional pin button when `showPin` (or equivalent); calls `onTogglePin` |

Derived layout helpers (pure, testable) if useful:

```ts
docked = desktopUi && sidebarPinned
visible = docked || drawerOpen
showTitleBarMenu = desktopUi && !sidebarPinned
```

## Edge cases

- First launch: unpinned.
- Resize below 720 while pinned: compact overlay; preference unchanged.
- Resize back above 720: dock again if still pinned.
- No new keyboard shortcut in this pass (hamburger + pin control only).

## Validation

- Unit-test preference parse/default and the `docked` / `visible` / hamburger gating helpers.
- Update `DesktopTerminalDrawer` / `SessionDrawer` tests: default unpinned overlay on wide desktop; docked when pinned; hamburger present only when unpinned; close-on-select only when unpinned.
- Typecheck + existing mobile tests.
- Manual Tauri check: open → pin → dock; unpin → collapsed; restart remembers pin; shrink/grow window respects preference.

## Non-goals

- Hover sidebar or top-tabs navigation modes (superseded earlier design ideas; out of scope here).
- Keyboard shortcut to toggle the drawer.
- Server-synced preferences.
- Changing mobile/compact drawer chrome.
- Pinning individual sessions (this is sidebar chrome pin, not session pin).
