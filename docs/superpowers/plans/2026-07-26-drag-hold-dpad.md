# Drag-and-hold terminal direction control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile terminal's four-key D-pad with one 44 px drag-and-hold puck that sends and repeats cardinal terminal arrows.

**Architecture:** Keep `UtilityBar` responsible for encoding, sending terminal bytes, and issuing one light haptic through its existing `onArrow` callback. Move gesture classification into `dpadModel.ts` so it can be tested without React Native, and have `Dpad.tsx` use `PanResponder` plus an animated thumb to turn pointer movement into direction transitions and repeat scheduling.

**Tech Stack:** React Native `PanResponder` and `Animated`, Expo Haptics, TypeScript, Bun tests, Biome, Expo web export.

## Global Constraints

- The control is exactly 44 × 44 px and must not increase the utility bar height.
- A tap or a drag that remains within the center threshold sends no terminal input.
- Use the existing `onArrow(direction)` callback so `UtilityBar` continues to apply `cursorSeq(direction)` for normal and application-cursor modes.
- The first selected direction sends immediately; repeat starts after 350 ms and continues every 60 ms.
- Direction changes send once and restart the 350 ms repeat delay; release, termination, and unmount cancel all timers.
- Diagonals resolve to their dominant axis; small movement around a diagonal boundary must not churn directions, input, or haptics.
- Every emitted arrow, including held-repeat ticks, triggers light haptic feedback.

---

## File structure

- `apps/mobile/src/dpadModel.ts`: Pure direction constants, threshold/hysteresis logic, and bounded visual-thumb offsets.
- `apps/mobile/src/dpad.test.ts`: Bun tests for neutral, cardinal, diagonal, hysteresis, and thumb-offset behavior.
- `apps/mobile/src/Dpad.tsx`: Single `PanResponder` control, animated thumb, repeat lifecycle, and accessibility copy.
- `apps/mobile/src/UtilityBar.tsx`: No behavioral rewrite; retain the existing `ArrowCluster` callback that applies haptic feedback and terminal cursor encoding.

### Task 1: Define and test the pure directional gesture model

**Files:**
- Modify: `apps/mobile/src/dpadModel.ts`
- Modify: `apps/mobile/src/dpad.test.ts`

**Interfaces:**
- Produces: `type DPadDirection = 'A' | 'B' | 'C' | 'D'`
- Produces: `resolveDPadDirection(dx: number, dy: number, active: DPadDirection | null): DPadDirection | null`
- Produces: `thumbOffset(dx: number, dy: number): { x: number; y: number }`
- Consumed by: `apps/mobile/src/Dpad.tsx`

- [ ] **Step 1: Write the failing model tests**

```ts
import { resolveDPadDirection, thumbOffset } from './dpadModel';

test('D-pad remains neutral inside the center threshold', () => {
  expect(resolveDPadDirection(5, -3, null)).toBeNull();
});

test('D-pad maps cardinals and diagonals to terminal finals', () => {
  expect(resolveDPadDirection(16, 0, null)).toBe('C');
  expect(resolveDPadDirection(-16, 0, null)).toBe('D');
  expect(resolveDPadDirection(0, -16, null)).toBe('A');
  expect(resolveDPadDirection(0, 16, null)).toBe('B');
  expect(resolveDPadDirection(20, 12, null)).toBe('C');
  expect(resolveDPadDirection(-12, 20, null)).toBe('B');
});

test('D-pad keeps its active direction near an axis boundary', () => {
  expect(resolveDPadDirection(15, 16, 'C')).toBe('C');
  expect(resolveDPadDirection(10, 20, 'C')).toBe('B');
});

test('D-pad thumb stays bounded inside its control', () => {
  expect(thumbOffset(100, -100)).toEqual({ x: 8, y: -8 });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun --cwd apps/mobile test src/dpad.test.ts`

Expected: FAIL because `resolveDPadDirection` and `thumbOffset` are not exported.

- [ ] **Step 3: Implement the pure model**

```ts
export const D_PAD_SIZE = MIN_TOUCH_TARGET;
export const D_PAD_THRESHOLD = 8;
const SWITCH_RATIO = 1.25;
const THUMB_LIMIT = 11;

export function resolveDPadDirection(
  dx: number,
  dy: number,
  active: DPadDirection | null,
): DPadDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < D_PAD_THRESHOLD) return null;
  const candidate: DPadDirection = ax >= ay ? (dx >= 0 ? 'C' : 'D') : dy >= 0 ? 'B' : 'A';
  if (!active || candidate === active) return candidate;
  const activeIsHorizontal = active === 'C' || active === 'D';
  const dominant = activeIsHorizontal ? ax : ay;
  const opposing = activeIsHorizontal ? ay : ax;
  return opposing < dominant * SWITCH_RATIO ? active : candidate;
}

export function thumbOffset(dx: number, dy: number): { x: number; y: number } {
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const scale = Math.min(THUMB_LIMIT / distance, 1);
  return { x: Math.round(dx * scale), y: Math.round(dy * scale) };
}
```

Keep the existing `D_PAD_DIRECTIONS` data during this task so the current `Dpad.tsx` remains typecheck-compatible. Task 2 removes it after the component is rewritten to consume `resolveDPadDirection` directly.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun --cwd apps/mobile test src/dpad.test.ts`

Expected: PASS with neutral, cardinal, diagonal, hysteresis, and thumb bounds covered.

- [ ] **Step 5: Commit the model contract**

```bash
git add apps/mobile/src/dpadModel.ts apps/mobile/src/dpad.test.ts
git commit -m "test: define d-pad gesture model"
```

### Task 2: Replace the button strip with one drag-and-hold puck

**Files:**
- Modify: `apps/mobile/src/Dpad.tsx`
- Modify: `apps/mobile/src/dpadModel.ts`
- Test: `apps/mobile/src/dpad.test.ts`

**Interfaces:**
- Consumes: `resolveDPadDirection(dx, dy, active)` and `thumbOffset(dx, dy)` from `dpadModel.ts`
- Consumes: `onArrow(direction: DPadDirection): void` from `UtilityBar.tsx`
- Produces: `ArrowCluster`, rendered as one accessible 44 × 44 px directional puck

- [ ] **Step 1: Verify the pure gesture contract before component wiring**

Run: `bun --cwd apps/mobile test src/dpad.test.ts`

Expected: PASS. The model contract must confirm that `resolveDPadDirection(0, 0, 'B')` returns `null`, so returning a held thumb to center stops repeating rather than preserving Down.

- [ ] **Step 2: Implement the puck and repeat lifecycle**

Replace the four `RepeatBtn` children with one `View` using a `PanResponder`. Store the active direction, initial repeat timeout, and repeat interval in refs. The event flow must match this pseudocode:

```ts
const activate = (next: DPadDirection | null) => {
  if (next === activeRef.current) return;
  stopRepeat();
  activeRef.current = next;
  if (!next) return;
  onArrow(next);
  delayRef.current = setTimeout(() => {
    intervalRef.current = setInterval(() => onArrow(activeRef.current!), 60);
  }, 350);
};

const update = (dx: number, dy: number) => {
  thumb.setValue(thumbOffset(dx, dy));
  activate(resolveDPadDirection(dx, dy, activeRef.current));
};

const finish = () => {
  stopRepeat();
  activeRef.current = null;
  Animated.spring(thumb, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
};
```

Configure `onStartShouldSetPanResponder` and `onMoveShouldSetPanResponder` to return `true` so a left/right drag beginning on the puck cannot scroll the enclosing horizontal shortcut bar. Call `finish` from release, responder termination, and effect cleanup. Remove `D_PAD_DIRECTIONS` after replacing the four-button JSX. Do not add haptics to `Dpad.tsx`: each `onArrow` call reaches `UtilityBar`, which already issues the required light haptic once per emitted arrow. Give the root `accessibilityRole="adjustable"` and label it `Terminal arrow control. Drag in a direction and hold to repeat.`

- [ ] **Step 3: Run tests, typecheck, and inspect the built web UI**

Run:

```bash
bun --cwd apps/mobile test src/dpad.test.ts
bun --cwd apps/mobile typecheck
bun --cwd apps/mobile build:web
```

Expected: all commands exit 0; the web build includes the single 44 px puck without changing utility-bar height.

- [ ] **Step 4: Commit the interaction**

```bash
git add apps/mobile/src/Dpad.tsx apps/mobile/src/dpadModel.ts apps/mobile/src/dpad.test.ts
git commit -m "feat: add drag-hold terminal d-pad"
```

### Task 3: Verify terminal integration and the complete mobile suite

**Files:**
- Test: `apps/mobile/src/desktopKeys.test.ts`
- Test: `apps/mobile/src/terminalRendererProtocol.test.ts`

**Interfaces:**
- Consumes: `ArrowCluster` with `onArrow(direction)`.
- Preserves: `sendInput(cursorSeq(direction))` in `UtilityBar`.
- Preserves: Down as `B` in normal CSI and application-cursor SS3 modes.

- [ ] **Step 1: Run the encoding regression test**

Run: `bun --cwd apps/mobile test src/desktopKeys.test.ts`

Expected: PASS, including existing assertions that Down emits `\x1b[B` in normal mode and `\x1bOB` in application-cursor mode.

- [ ] **Step 2: Run the full verification gate**

Run after the feature commits:

```bash
bun --cwd apps/mobile test
bun --cwd apps/mobile typecheck
bun --cwd apps/mobile build:web
bunx biome check apps/mobile/src/Dpad.tsx apps/mobile/src/dpadModel.ts apps/mobile/src/dpad.test.ts apps/mobile/src/UtilityBar.tsx
git diff --check
```

Expected: 0 failures, 0 TypeScript errors, successful web export, no Biome diagnostics, and no whitespace errors.
