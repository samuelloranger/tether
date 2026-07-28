# Unified desktop session drawer

Date: 2026-07-28  
Status: designed

## Context

Desktop navigation currently has two unrelated presentations:

- Wide windows render `DesktopSessionNavigator`, with Sidebar, On hover, and Tabs modes.
- Compact windows render the mobile header and open `SessionDrawer` as an overlay.

The two implementations expose different hierarchy and behavior. Resizing the window therefore
changes not only the available space, but the navigation model itself.

## Design

`SessionDrawer` becomes the only session-navigation component.

- At the existing desktop breakpoint, it renders with `docked` and remains permanently visible
  beside the terminal.
- Below that breakpoint, it remains the existing slide-over drawer opened from the compact header.
- Both variants render the same hosts, health states, sessions, previews, host actions, Add host,
  and New terminal controls.

The breakpoint changes only presentation—docked versus overlay—not information architecture or
available actions.

## Drawer hierarchy

Remove the drawer's top-level **Workspace** header and its global Settings gear. Global Settings
remains available from the desktop title bar and compact terminal header.

Each host section keeps its own settings gear because it has a distinct destination: that host's
unified settings page.

The drawer starts directly with host sections, followed by previews and Add host. New terminal
remains pinned at the bottom.

## Removed behavior

Remove the Sidebar / On hover / Tabs preference from the overflow menu and preference state. The
three-mode `DesktopSessionNavigator` implementation becomes obsolete and is removed.

Existing persisted navigation-mode values may remain in storage; they are ignored. No migration is
required because the values are harmless and no longer read.

## Responsive behavior

The existing content-driven desktop breakpoint remains unchanged.

- Wide desktop: drawer is docked, always visible, and reserves its established fixed width.
- Compact desktop: terminal uses the compact header; the same drawer opens as an overlay.
- Native mobile: behavior remains the existing overlay drawer.

Touch targets, safe-area handling, reduced-motion behavior, Catppuccin colors, and terminal layout
constraints do not change.

## Testing

- Component coverage proves docked and overlay variants expose the same navigation content.
- The drawer no longer renders “Workspace” or a global Settings button.
- Per-host settings actions remain present.
- Terminal layout coverage proves wide desktop renders a docked `SessionDrawer` and compact desktop
  renders its overlay trigger.
- The desktop navigation preference is absent from the overflow menu.
- Existing session selection, host health, preview, Add host, New terminal, and kill tests remain
  green.
- Run the Tauri app and resize across the breakpoint to verify that only docking changes.

## Out of scope

- Changing the drawer width or the desktop breakpoint.
- Redesigning host rows, session rows, or the terminal title bar.
- Changing mobile drawer animation.
- Changing host or session data contracts.
