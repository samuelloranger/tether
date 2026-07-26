# Mobile Terminal Selection Menu

## Goal

Restore discoverable access to the existing selectable terminal transcript after
the xterm renderer removed the long-press gesture.

## Design

- Replace the mobile overflow action “Search displayed transcript” with
  “Select terminal text”.
- Reuse `openSelectionView` and the existing `SelectionView`; its filter field
  remains available inside the view.
- Capture the active terminal snapshot when the action is pressed. Keep that
  snapshot unchanged while live output continues behind the modal.
- Do not add another menu item, viewer, gesture, or live-update mode.

## Verification

- The overflow action opens `SelectionView` with the current transcript.
- Output received after opening does not alter the displayed text.
- Closing and reopening captures a new snapshot.
- Existing mobile tests, typecheck, and lint pass.
