# Custom Titlebar — Design

**Date:** 2026-07-13
**Status:** Approved (design), pending implementation plan
**Component:** `apps/mobile` (Tauri desktop build)

## Problem

Tether's desktop build (Tauri wrapping the react-native-web bundle) currently uses
the native OS title bar (`decorations` unset → defaults to `true`). We want a
**custom in-app toolbar that replaces the native titlebar** — a single top bar
carrying the session tabs, action buttons, and window controls.

Because this is a frameless-window feature, responsibilities the OS handled for
free (window dragging, minimize/maximize/close, double-click-to-maximize,
per-OS control conventions, macOS fullscreen) must be re-implemented and adapted
per platform. Must ship on **macOS, Windows, and Linux**.

## Decisions (from brainstorming)

- **Window controls:** native on macOS (keep the traffic lights), custom on
  Windows/Linux (draw our own min/max/close on the right).
- **Behaviors:** drag-to-move, double-click-to-maximize, macOS native fullscreen —
  all in scope. Windows Snap Layouts deferred to Phase 3.
- **Config strategy:** platform-specific Tauri config files (declarative merge),
  not runtime Rust config.
- **Scope:** build both the frameless plumbing AND the toolbar UI; all three
  desktop platforms.

## Non-goals

- Windows 11 Snap Layouts flyout on maximize-button hover (Phase 3; needs a
  native Win32 `WM_NCHITTEST` window-proc hook — not achievable with a custom
  HTML button alone).
- Any change to the mobile (iOS/Android) app. The toolbar is desktop-only
  (`isDesktop === Platform.OS === 'web'`); mobile keeps its existing chrome.
- Custom window resize borders beyond what the compositor/Tauri provide by
  default (see Risks).

## Architecture

### §1. Per-OS window configuration (declarative, merged)

Tauri merges platform-specific config files into `tauri.conf.json` using JSON
Merge Patch (RFC 7396).

- **`apps/mobile/src-tauri/tauri.conf.json`** (base): the `app.windows[0]` object
  gains `"decorations": false`. Used as-is on **Windows + Linux** (fully frameless,
  we draw controls).
- **`apps/mobile/src-tauri/tauri.macos.conf.json`** (new): overrides `app.windows`
  with `decorations: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true` so the
  native macOS traffic lights float over our toolbar and the title text is hidden.

> **Gotcha (must implement correctly):** RFC 7396 replaces arrays *wholesale* — it
> does not merge array elements. Because `app.windows` is an array, the macOS file
> must repeat the **entire** `windows[0]` object (title, width, height, minWidth,
> minHeight, plus the three overrides), or those base fields are lost.

### §2. Frontend components (new)

- **`apps/mobile/src/TitleBar.tsx`** — the toolbar. Rendered only when `isDesktop`,
  replacing the current `styles.header` block in `App.tsx`. Structure:
  - a drag-region background spanning the bar,
  - session tabs / switcher (reusing the `drawerSessions` data already in `App.tsx`),
  - action buttons (new terminal, settings),
  - **Windows/Linux only:** the min/max/close control cluster on the right,
  - **macOS only:** a left inset (~72px) reserving space for the native traffic
    lights instead of the custom cluster.
- **`apps/mobile/src/windowControls.ts`** — web-only thin wrapper over
  `@tauri-apps/api/window`: `minimize()`, `toggleMaximize()`, `close()`,
  `isMaximized()` (to swap the maximize/restore glyph). Lazily imported so it never
  enters the mobile bundle — same pattern as `src/dialog.ts`.
- **`apps/mobile/src/titlebarChrome.ts`** — pure, platform-flag-driven helper:
  given `isMac`, returns whether to render the custom control cluster
  (`showControls = !isMac`) and the left inset width (`leftInset = isMac ? 72 : 0`).
  Unit-tested, mirroring `src/desktopKeys.ts` + `src/desktopKeys.test.ts`.

### §3. Drag region (react-native-web specifics)

RN-web renders `<View>` as `<div>`. The Tauri drag attribute is applied via the
RN-web `dataSet` prop: `dataSet={{ tauriDragRegion: '' }}` → `data-tauri-drag-region`.

A small **web-only injected stylesheet** (run once on desktop mount) adds:

```css
[data-tauri-drag-region] { app-region: drag; -webkit-app-region: drag; }
[data-tauri-no-drag]     { app-region: no-drag; -webkit-app-region: no-drag; }
```

(`-webkit-` prefix for WebKitGTK/WKWebView; unprefixed for Chromium/WebView2.)

All interactive controls (tabs, action buttons, window-control buttons) carry
`dataSet={{ tauriNoDrag: '' }}` so their clicks are not swallowed by the
region-based drag on Windows.

**Double-click-to-maximize** is handled automatically by Tauri's drag-region
mousedown handler — no extra code.

### §4. Permissions & Linux

Add to `apps/mobile/src-tauri/capabilities/default.json`:
`core:window:allow-minimize`, `core:window:allow-close`,
`core:window:allow-toggle-maximize`, `core:window:allow-start-dragging`,
`core:window:allow-is-maximized`.

Linux notes:
- `decorations: false` removes GTK client-side decorations, so the existing
  XWayland titlebar workaround (`main.rs`) becomes moot *for the titlebar* — but
  the `GDK_BACKEND=wayland,x11` preference is **kept** (it still helps rendering).
- Drag via `data-tauri-drag-region` + `startDragging` works under both X11 and
  Wayland in Tauri v2.

## Data flow

1. `App.tsx` renders `<TitleBar>` (desktop only) with the session list, active id,
   and the same `onNew`/`onSettings`/`onSelect`/`onKill` callbacks the docked
   `SessionDrawer` already uses.
2. Drag: user presses empty toolbar → Tauri's drag-region handler → OS moves the
   window. Double-click → Tauri toggles maximize.
3. Custom controls (Win/Linux): button press → `windowControls.ts` →
   `getCurrentWindow().minimize()/toggleMaximize()/close()`.
4. macOS: traffic lights operate natively (incl. green → native fullscreen). When
   fullscreen toggles, the ~72px inset should collapse; `TitleBar` listens to the
   window fullscreen/resize event (via `getCurrentWindow`) to drop the inset.

## Testing strategy

- **Unit (`bun test`, the only test kind this repo runs):**
  `titlebarChrome.test.ts` asserts the pure decisions — controls shown iff not
  macOS, inset applied iff macOS — with an injected platform flag (no DOM).
- **Typecheck:** `bun --cwd apps/mobile run lint` (`tsc --noEmit`) stays clean.
- **Manual, per-OS (cannot run Mac/Windows locally):** build all three via the
  existing `workflow_dispatch` desktop job in `.github/workflows/release.yml`
  (build-only, uploads workflow artifacts), then verify on each OS: window drag,
  double-click-maximize, min/max/close, and macOS native fullscreen + traffic
  lights.

## Risks & open items

- **Windows region-drag vs. controls:** every interactive element must be tagged
  `no-drag`, or it becomes undraggable-but-also-unclickable dead zones. Covered by
  a consistent `tauriNoDrag` convention on all controls.
- **Linux edge-resize:** some compositors drop resize borders when
  `decorations: false`. If a target compositor is affected, a follow-up may add
  `startResizeDragging` edge handles. Confirm during manual test.
- **macOS inset drift:** traffic-light position is fixed by the OS; the 72px inset
  is empirical. Verify against the actual overlay geometry during manual test.
- **Snap Layouts (Phase 3):** requires a native Windows window-proc subclass
  answering `WM_NCHITTEST` with `HTMAXBUTTON` over the maximize button's rect.
  Native, Windows-only, untestable in this environment — intentionally deferred.

## Phasing

1. **Frameless + drag + macOS inset:** base/macOS config files, drag-region CSS +
   attributes, macOS traffic-light inset. Window is movable and closable via the
   traffic lights on macOS.
2. **Custom controls (Win/Linux):** `windowControls.ts`, the control cluster in
   `TitleBar.tsx`, capability permissions, maximize/restore icon state.
3. **(stretch) Windows Snap Layouts:** native `WM_NCHITTEST` hook.
