# Drag-and-hold terminal direction control

## Goal

Replace the terminal shortcut bar's four-button D-pad with one compact directional puck. It must make all cardinal arrows easy to target without increasing the utility bar height.

## Interaction

- The puck is a 44 × 44 px control in the existing shortcut bar.
- A touch begins in neutral. A tap or release before crossing the movement threshold sends nothing.
- Dragging beyond the threshold selects one cardinal direction. Diagonal movement resolves to the axis with the greater displacement.
- Selecting a direction sends one matching terminal arrow immediately.
- Holding that direction repeats after 350 ms, then every 60 ms.
- Crossing into another direction sends that direction once and restarts the repeat delay.
- Releasing always cancels timers and restores neutral state.
- The visual thumb moves toward the active direction and springs back on release. Haptics fire on direction selection or change, never on repeats.

## Architecture

- Keep arrow encoding in `UtilityBar`: it continues to call `cursorSeq(direction)` and `sendInput`, preserving normal and application-cursor modes.
- Replace `ArrowCluster` internals with a single `PanResponder`-backed directional puck; callers keep the same `onArrow` callback shape.
- Extract pure gesture classification and repeat-state helpers so the threshold, dominant-axis choice, and transitions are deterministic and unit-testable.
- The puck captures touches that begin inside it, preventing horizontal toolbar scrolling from competing with left/right gestures.

## Failure handling

- An absent or zero-distance drag remains neutral and emits no input.
- Unmount, responder termination, and release all clear the initial repeat timeout and interval.
- A direction remains stable while the drag is within its selected sector, avoiding rapid haptic/input churn around the diagonal boundary.

## Verification

- Unit tests cover neutral taps, cardinal and diagonal classification, direction transitions, and repeat cancellation.
- Existing terminal input tests continue to cover `B` for Down in both normal and application-cursor encodings.
- Run the full mobile test suite, typecheck, web export, formatting check, and diff check.
