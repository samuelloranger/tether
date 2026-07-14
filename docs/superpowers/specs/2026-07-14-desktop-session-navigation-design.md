# Configurable desktop session navigation

## Goal

Let desktop users choose how terminal sessions are navigated without changing the mobile UI. The desktop overflow menu offers three direct choices: a persistent sidebar, a left-edge hover sidebar, and top tabs. The selection applies immediately and is restored after restart.

## Scope

- Desktop only (`Platform.OS === 'web'` in the Tauri build).
- Reuse the existing session list, selection, creation, kill, and settings callbacks.
- Keep the current persistent sidebar as the default.
- Do not add server settings, a new dependency, or a new preference system.

## Component boundary

Add `DesktopSessionNavigator`, a presentational desktop component that receives:

- the current navigation mode;
- the existing sessions and active session ID;
- callbacks for select, new terminal, kill, and settings.

It owns only local hover visibility. `TerminalScreen` owns layout placement and gets the selected persisted mode from `useTetherApp`. The navigator must not own terminal, socket, or session-list state.

## Modes

### Sidebar

Render the current session navigator as a fixed 264px left column. The terminal pane subtracts that width, preserving its current resize behavior.

### On hover

Render a narrow left-edge hover target plus the navigator as an absolute overlay. The navigator opens on pointer entry and closes immediately once the pointer leaves the combined target-and-panel region. It must not reserve terminal width.

### Tabs

Render a horizontal, scrollable session-tab row immediately beneath the title bar. Each tab contains the session name, its status dot, and a close control. Selecting a tab calls the existing session-switch function. Closing uses the existing destructive kill confirmation. The title-bar New Terminal and Settings controls remain available.

## Selection menu and persistence

Add a desktop-only `Navigation` section to the existing title-bar overflow menu. It presents three direct labeled buttons: `Sidebar`, `On hover`, and `Tabs`. The active choice is visibly selected. Selecting a choice updates the UI, persists it, and closes the menu.

Store the selection under `tether_desktop_navigation_mode` using the existing AsyncStorage pattern. Valid values are `sidebar`, `hover`, and `tabs`; missing, malformed, or failed reads default to `sidebar`. A failed write does not undo the already-applied in-memory choice. Mobile neither displays nor reads this control.

## Error handling and accessibility

- Invalid stored values use the default without surfacing an error.
- Existing kill confirmation remains the sole destructive-action guard.
- Selector buttons and tabs expose descriptive accessibility labels and selected state.
- The hover affordance is desktop-only; the overflow-menu selector remains an accessible non-pointer way to choose a durable navigation mode.

## Validation

- Unit-test parsing/defaulting and persistence of the navigation mode.
- Render-test all modes, including selector state, session switching, new/settings callbacks, and kill wiring.
- Test that hover opens on pointer entry and closes on pointer exit.
- Test tabs with more sessions than fit in the available width.
- Run TypeScript checks and the existing mobile tests.
- Manually test all modes in the Tauri desktop build, including terminal column resizing when switching between a width-reserving sidebar and full-width modes.

## Non-goals

- Mobile navigation changes.
- Server-synchronized preferences.
- Reordering, pinning, grouping, or drag-and-drop session tabs.
- Adding a fourth navigation mode.
