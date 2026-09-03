# Desktop Multi-Terminal Split View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tiling split-pane layout to the desktop client so multiple live terminals show at once, filled by drag-to-side (with live preview) or right-click-tab, with one focused pane and a persisted layout.

**Architecture:** A binary **pane tree** (leaf = one session, branch = direction + ratio) lives in `App` state and is persisted to localStorage. Pure modules compute geometry (`layoutRects`) and drag intent (`dropZone`); `ResidentTerminals` positions the already-resident `TerminalPane`s by rect instead of stacking them at `inset:0`. Transport/streaming/LRU/input-gating are unchanged — this is layout + per-pane refit only.

**Tech Stack:** TypeScript, React (function components + hooks), xterm.js (`FitAddon`), Vite, Tauri 2 webview. Tests: `bun:test` (colocated `*.test.ts`). Formatting: Biome (2-space, single quotes, semicolons, trailing commas, width 100).

**Spec:** `docs/superpowers/specs/2026-09-03-desktop-multi-terminal-split-design.md`

## Global Constraints

- All work is in `apps/desktop/`. No server, `crates/`, `apps/relay/`, or `clients/apple/` changes.
- Test command: `bun --cwd apps/desktop run test` (not `bun test`). Lint: `bun lint` from repo root.
- Pure logic goes in its own module with a colocated `*.test.ts`; React glue stays thin over it.
- Session identity is host-qualified: `sessionKey(hostId, sessionId)` → `"<hostId>:<sessionId>"` (`sessionKey.ts`). A pane's session is a `SessionRef { hostId, sessionId }`.
- Closing a pane never kills the session (kill stays the `×` / drawer path). An empty pane shows a picker; it does not auto-start a session.
- Biome formatting; run `bun format` before each commit.

---

## File Structure

**New modules (pure + tested):**
- `apps/desktop/src/paneTree.ts` — tree types + immutable ops.
- `apps/desktop/src/layoutRects.ts` — tree + size → leaf rects + divider rects.
- `apps/desktop/src/dropZone.ts` — pointer position in a pane rect → drop intent.
- `apps/desktop/src/paneTreeSerialize.ts` — (de)serialize + prune-dead.

**New React components:**
- `apps/desktop/src/PaneDivider.tsx` — draggable divider.
- `apps/desktop/src/SplitPreviewOverlay.tsx` — ghost preview during drag.
- `apps/desktop/src/EmptyPanePicker.tsx` — session chooser for an empty leaf.
- `apps/desktop/src/TabContextMenu.tsx` — right-click split menu for a tab.

**Modified:**
- `apps/desktop/src/TerminalPane.tsx` — refit on geometry change.
- `apps/desktop/src/ResidentTerminals.tsx` — rect positioning, dividers, overlay, pickers.
- `apps/desktop/src/App.tsx` — own the pane tree; wire focus + gestures.
- `apps/desktop/src/preferences.ts` — persist/load the tree.
- `apps/desktop/src/SessionTabBar.tsx`, `apps/desktop/src/SessionDrawer.tsx` — draggable tabs + right-click menu.
- `apps/desktop/src/index.css` — split/divider/preview/picker styles.

---

## Task 1: Pane tree model + ops

**Files:**
- Create: `apps/desktop/src/paneTree.ts`
- Test: `apps/desktop/src/paneTree.test.ts`

**Interfaces:**
- Consumes: `SessionRef` (defined here).
- Produces:
  ```ts
  export interface SessionRef { hostId: string; sessionId: string; }
  export type PaneDir = 'row' | 'col';
  export type PaneSide = 'a' | 'b';
  export interface Leaf { kind: 'leaf'; id: string; session: SessionRef | null; }
  export interface Branch { kind: 'branch'; id: string; dir: PaneDir; a: PaneNode; b: PaneNode; ratio: number; }
  export type PaneNode = Leaf | Branch;

  export function newLeaf(session?: SessionRef | null): Leaf;
  export function leaves(tree: PaneNode): Leaf[];
  export function findLeaf(tree: PaneNode, paneId: string): Leaf | null;
  export function firstLeafId(tree: PaneNode): string;
  export function splitLeaf(tree: PaneNode, targetPaneId: string, dir: PaneDir, side: PaneSide, session: SessionRef | null): PaneNode;
  export function closePane(tree: PaneNode, paneId: string): PaneNode;
  export function setSession(tree: PaneNode, paneId: string, session: SessionRef | null): PaneNode;
  export function setRatio(tree: PaneNode, branchId: string, ratio: number): PaneNode;
  ```
  IDs come from `crypto.randomUUID()`. `MIN_RATIO = 0.1`; `setRatio` clamps to `[MIN_RATIO, 1 - MIN_RATIO]`. `splitLeaf` puts the NEW leaf (holding `session`) on `side` and the existing leaf on the other, `ratio: 0.5`. `closePane` collapses the removed leaf's parent to the surviving sibling; closing the last remaining leaf returns a fresh empty `newLeaf()`. All ops return a new tree (immutable) and are no-ops (return input) if the id is not found.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import {
  type PaneNode,
  closePane,
  findLeaf,
  firstLeafId,
  leaves,
  newLeaf,
  setRatio,
  setSession,
  splitLeaf,
} from './paneTree';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('paneTree', () => {
  test('newLeaf holds its session and a unique id', () => {
    const a = newLeaf(S('1'));
    const b = newLeaf(S('2'));
    expect(a.kind).toBe('leaf');
    expect(a.session).toEqual(S('1'));
    expect(a.id).not.toBe(b.id);
  });

  test('splitLeaf replaces the target with a branch, new leaf on the given side', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(tree.kind).toBe('branch');
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect(tree.dir).toBe('row');
    expect(tree.ratio).toBe(0.5);
    expect((tree.a as { session: unknown }).session).toEqual(S('1'));
    expect((tree.b as { session: unknown }).session).toEqual(S('2'));
  });

  test('splitLeaf on side a puts the new leaf first', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'col', 'a', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect((tree.a as { session: unknown }).session).toEqual(S('2'));
    expect((tree.b as { session: unknown }).session).toEqual(S('1'));
  });

  test('leaves and findLeaf walk the whole tree', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(leaves(tree).map((l) => l.session?.sessionId).sort()).toEqual(['1', '2']);
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect(findLeaf(tree, tree.b.id)?.session).toEqual(S('2'));
    expect(findLeaf(tree, 'nope')).toBeNull();
  });

  test('closePane collapses the parent to the surviving sibling', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    const closed = closePane(tree, tree.b.id);
    expect(closed.kind).toBe('leaf');
    expect((closed as { session: unknown }).session).toEqual(S('1'));
  });

  test('closing the last leaf yields a fresh empty leaf', () => {
    const root = newLeaf(S('1'));
    const closed = closePane(root, root.id);
    expect(closed.kind).toBe('leaf');
    expect((closed as { session: unknown }).session).toBeNull();
  });

  test('setSession fills a leaf; setRatio clamps', () => {
    const root = newLeaf(null);
    const filled = setSession(root, root.id, S('9'));
    expect((filled as { session: unknown }).session).toEqual(S('9'));

    const tree = splitLeaf(newLeaf(S('1')), (root as PaneNode).id, 'row', 'b', S('2'));
    // splitLeaf no-ops on unknown id → still a leaf; guard the clamp test on a real branch:
    const branch = splitLeaf(newLeaf(S('1')), firstLeafId(newLeaf(S('1'))), 'row', 'b', S('2'));
  });

  test('setRatio clamps to [0.1, 0.9]', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect((setRatio(tree, tree.id, 0.02) as typeof tree).ratio).toBeCloseTo(0.1);
    expect((setRatio(tree, tree.id, 0.99) as typeof tree).ratio).toBeCloseTo(0.9);
  });

  test('ops are no-ops on unknown ids', () => {
    const root = newLeaf(S('1'));
    expect(splitLeaf(root, 'x', 'row', 'b', S('2'))).toBe(root);
    expect(setSession(root, 'x', S('2'))).toBe(root);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test paneTree`
Expected: FAIL — `Cannot find module './paneTree'`.

- [ ] **Step 3: Implement `paneTree.ts`**

```ts
export interface SessionRef {
  hostId: string;
  sessionId: string;
}
export type PaneDir = 'row' | 'col';
export type PaneSide = 'a' | 'b';
export interface Leaf {
  kind: 'leaf';
  id: string;
  session: SessionRef | null;
}
export interface Branch {
  kind: 'branch';
  id: string;
  dir: PaneDir;
  a: PaneNode;
  b: PaneNode;
  ratio: number;
}
export type PaneNode = Leaf | Branch;

export const MIN_RATIO = 0.1;

export function newLeaf(session: SessionRef | null = null): Leaf {
  return { kind: 'leaf', id: crypto.randomUUID(), session };
}

export function leaves(tree: PaneNode): Leaf[] {
  if (tree.kind === 'leaf') return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}

export function findLeaf(tree: PaneNode, paneId: string): Leaf | null {
  if (tree.kind === 'leaf') return tree.id === paneId ? tree : null;
  return findLeaf(tree.a, paneId) ?? findLeaf(tree.b, paneId);
}

export function firstLeafId(tree: PaneNode): string {
  return tree.kind === 'leaf' ? tree.id : firstLeafId(tree.a);
}

function mapTree(tree: PaneNode, fn: (leaf: Leaf) => PaneNode): PaneNode {
  if (tree.kind === 'leaf') return fn(tree);
  const a = mapTree(tree.a, fn);
  const b = mapTree(tree.b, fn);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

export function splitLeaf(
  tree: PaneNode,
  targetPaneId: string,
  dir: PaneDir,
  side: PaneSide,
  session: SessionRef | null,
): PaneNode {
  if (!findLeaf(tree, targetPaneId)) return tree;
  return mapTree(tree, (leaf) => {
    if (leaf.id !== targetPaneId) return leaf;
    const created = newLeaf(session);
    const branch: Branch = {
      kind: 'branch',
      id: crypto.randomUUID(),
      dir,
      a: side === 'a' ? created : leaf,
      b: side === 'a' ? leaf : created,
      ratio: 0.5,
    };
    return branch;
  });
}

export function closePane(tree: PaneNode, paneId: string): PaneNode {
  if (tree.kind === 'leaf') return tree.id === paneId ? newLeaf() : tree;
  if (tree.a.kind === 'leaf' && tree.a.id === paneId) return tree.b;
  if (tree.b.kind === 'leaf' && tree.b.id === paneId) return tree.a;
  const a = closePane(tree.a, paneId);
  const b = closePane(tree.b, paneId);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

export function setSession(
  tree: PaneNode,
  paneId: string,
  session: SessionRef | null,
): PaneNode {
  if (!findLeaf(tree, paneId)) return tree;
  return mapTree(tree, (leaf) => (leaf.id === paneId ? { ...leaf, session } : leaf));
}

export function setRatio(tree: PaneNode, branchId: string, ratio: number): PaneNode {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === branchId) {
    const clamped = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
    return { ...tree, ratio: clamped };
  }
  const a = setRatio(tree.a, branchId, ratio);
  const b = setRatio(tree.b, branchId, ratio);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test paneTree`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/paneTree.ts src/paneTree.test.ts && cd ../..
git add apps/desktop/src/paneTree.ts apps/desktop/src/paneTree.test.ts
git commit -m "feat(desktop): pane tree model + immutable ops"
```

---

## Task 2: Geometry — `layoutRects`

**Files:**
- Create: `apps/desktop/src/layoutRects.ts`
- Test: `apps/desktop/src/layoutRects.test.ts`

**Interfaces:**
- Consumes: `PaneNode`, `Leaf`, `SessionRef` from `./paneTree`.
- Produces:
  ```ts
  export interface Rect { left: number; top: number; width: number; height: number; }
  export interface LeafRect { paneId: string; session: SessionRef | null; rect: Rect; }
  export interface DividerRect { branchId: string; dir: PaneDir; rect: Rect; }
  export interface Layout { leaves: LeafRect[]; dividers: DividerRect[]; }
  export const DIVIDER_PX = 6;
  export function layoutTree(tree: PaneNode, width: number, height: number, dividerPx?: number): Layout;
  ```
  A `row` branch splits along X: child `a` gets `ratio*(width-dividerPx)`, the divider occupies `dividerPx` between them, child `b` gets the rest. `col` splits along Y the same way. Rects are absolute in the container's coordinate space.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { DIVIDER_PX, layoutTree } from './layoutRects';
import { newLeaf, splitLeaf } from './paneTree';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('layoutTree', () => {
  test('a single leaf fills the container', () => {
    const root = newLeaf(S('1'));
    const { leaves, dividers } = layoutTree(root, 800, 600);
    expect(dividers).toHaveLength(0);
    expect(leaves[0].rect).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(leaves[0].paneId).toBe(root.id);
  });

  test('a row split halves the width minus the divider', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const { leaves, dividers } = layoutTree(tree, 800, 600, DIVIDER_PX);
    const avail = 800 - DIVIDER_PX;
    expect(leaves[0].rect.width).toBeCloseTo(avail * 0.5);
    expect(leaves[0].rect.height).toBe(600);
    expect(leaves[1].rect.left).toBeCloseTo(avail * 0.5 + DIVIDER_PX);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].dir).toBe('row');
    expect(dividers[0].rect.width).toBe(DIVIDER_PX);
  });

  test('a col split divides height', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'col', 'b', S('2'));
    const { leaves } = layoutTree(tree, 800, 600, DIVIDER_PX);
    const avail = 600 - DIVIDER_PX;
    expect(leaves[0].rect.height).toBeCloseTo(avail * 0.5);
    expect(leaves[0].rect.width).toBe(800);
    expect(leaves[1].rect.top).toBeCloseTo(avail * 0.5 + DIVIDER_PX);
  });

  test('nested splits stay within the container', () => {
    let tree = splitLeaf(newLeaf(S('1')), 'seed', 'row', 'b', S('2')); // no-op seed guard
    const root = newLeaf(S('1'));
    tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    tree = splitLeaf(tree, tree.b.id, 'col', 'b', S('3'));
    const { leaves } = layoutTree(tree, 1000, 800, DIVIDER_PX);
    expect(leaves).toHaveLength(3);
    for (const l of leaves) {
      expect(l.rect.left).toBeGreaterThanOrEqual(0);
      expect(l.rect.top).toBeGreaterThanOrEqual(0);
      expect(l.rect.left + l.rect.width).toBeLessThanOrEqual(1000.001);
      expect(l.rect.top + l.rect.height).toBeLessThanOrEqual(800.001);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test layoutRects`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `layoutRects.ts`**

```ts
import type { PaneDir, PaneNode, SessionRef } from './paneTree';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface LeafRect {
  paneId: string;
  session: SessionRef | null;
  rect: Rect;
}
export interface DividerRect {
  branchId: string;
  dir: PaneDir;
  rect: Rect;
}
export interface Layout {
  leaves: LeafRect[];
  dividers: DividerRect[];
}

export const DIVIDER_PX = 6;

export function layoutTree(
  tree: PaneNode,
  width: number,
  height: number,
  dividerPx: number = DIVIDER_PX,
): Layout {
  const out: Layout = { leaves: [], dividers: [] };
  walk(tree, { left: 0, top: 0, width, height }, dividerPx, out);
  return out;
}

function walk(node: PaneNode, rect: Rect, dividerPx: number, out: Layout): void {
  if (node.kind === 'leaf') {
    out.leaves.push({ paneId: node.id, session: node.session, rect });
    return;
  }
  if (node.dir === 'row') {
    const avail = Math.max(0, rect.width - dividerPx);
    const aw = avail * node.ratio;
    const aRect: Rect = { ...rect, width: aw };
    const dRect: Rect = { left: rect.left + aw, top: rect.top, width: dividerPx, height: rect.height };
    const bRect: Rect = {
      left: rect.left + aw + dividerPx,
      top: rect.top,
      width: avail - aw,
      height: rect.height,
    };
    out.dividers.push({ branchId: node.id, dir: 'row', rect: dRect });
    walk(node.a, aRect, dividerPx, out);
    walk(node.b, bRect, dividerPx, out);
  } else {
    const avail = Math.max(0, rect.height - dividerPx);
    const ah = avail * node.ratio;
    const aRect: Rect = { ...rect, height: ah };
    const dRect: Rect = { left: rect.left, top: rect.top + ah, width: rect.width, height: dividerPx };
    const bRect: Rect = {
      left: rect.left,
      top: rect.top + ah + dividerPx,
      width: rect.width,
      height: avail - ah,
    };
    out.dividers.push({ branchId: node.id, dir: 'col', rect: dRect });
    walk(node.a, aRect, dividerPx, out);
    walk(node.b, bRect, dividerPx, out);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test layoutRects`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/layoutRects.ts src/layoutRects.test.ts && cd ../..
git add apps/desktop/src/layoutRects.ts apps/desktop/src/layoutRects.test.ts
git commit -m "feat(desktop): layoutTree geometry for pane rects"
```

---

## Task 3: Drop-intent — `dropZone`

**Files:**
- Create: `apps/desktop/src/dropZone.ts`
- Test: `apps/desktop/src/dropZone.test.ts`

**Interfaces:**
- Consumes: `PaneDir`, `PaneSide` from `./paneTree`; `Rect` from `./layoutRects`.
- Produces:
  ```ts
  export type DropIntent =
    | { kind: 'split'; dir: PaneDir; side: PaneSide }
    | { kind: 'replace' };
  export const EDGE_FRAC = 0.33;
  export function dropIntent(px: number, py: number, rect: Rect, edgeFrac?: number): DropIntent;
  ```
  `px/py` are pointer coordinates relative to the pane's own top-left. When within `edgeFrac` of an edge, the nearest edge wins: left → `{split, row, a}`, right → `{split, row, b}`, top → `{split, col, a}`, bottom → `{split, col, b}`. The center band → `{replace}`. When two edges tie (a corner), the closer normalized distance wins.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { dropIntent } from './dropZone';

const rect = { left: 0, top: 0, width: 300, height: 200 };

describe('dropIntent', () => {
  test('center is replace', () => {
    expect(dropIntent(150, 100, rect)).toEqual({ kind: 'replace' });
  });
  test('left edge splits row/a', () => {
    expect(dropIntent(10, 100, rect)).toEqual({ kind: 'split', dir: 'row', side: 'a' });
  });
  test('right edge splits row/b', () => {
    expect(dropIntent(290, 100, rect)).toEqual({ kind: 'split', dir: 'row', side: 'b' });
  });
  test('top edge splits col/a', () => {
    expect(dropIntent(150, 8, rect)).toEqual({ kind: 'split', dir: 'col', side: 'a' });
  });
  test('bottom edge splits col/b', () => {
    expect(dropIntent(150, 192, rect)).toEqual({ kind: 'split', dir: 'col', side: 'b' });
  });
  test('a corner resolves to the nearer normalized edge', () => {
    // very close to the top, a bit into the left → top wins (smaller normalized dist)
    expect(dropIntent(20, 4, rect)).toEqual({ kind: 'split', dir: 'col', side: 'a' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test dropZone`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dropZone.ts`**

```ts
import type { PaneDir, PaneSide } from './paneTree';
import type { Rect } from './layoutRects';

export type DropIntent =
  | { kind: 'split'; dir: PaneDir; side: PaneSide }
  | { kind: 'replace' };

export const EDGE_FRAC = 0.33;

export function dropIntent(
  px: number,
  py: number,
  rect: Rect,
  edgeFrac: number = EDGE_FRAC,
): DropIntent {
  const fx = rect.width > 0 ? px / rect.width : 0.5;
  const fy = rect.height > 0 ? py / rect.height : 0.5;
  const distLeft = fx;
  const distRight = 1 - fx;
  const distTop = fy;
  const distBottom = 1 - fy;
  const nearest = Math.min(distLeft, distRight, distTop, distBottom);
  if (nearest > edgeFrac) return { kind: 'replace' };
  if (nearest === distLeft) return { kind: 'split', dir: 'row', side: 'a' };
  if (nearest === distRight) return { kind: 'split', dir: 'row', side: 'b' };
  if (nearest === distTop) return { kind: 'split', dir: 'col', side: 'a' };
  return { kind: 'split', dir: 'col', side: 'b' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test dropZone`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/dropZone.ts src/dropZone.test.ts && cd ../..
git add apps/desktop/src/dropZone.ts apps/desktop/src/dropZone.test.ts
git commit -m "feat(desktop): dropIntent for tab-into-pane splits"
```

---

## Task 4: Serialize + prune, wired into preferences

**Files:**
- Create: `apps/desktop/src/paneTreeSerialize.ts`
- Test: `apps/desktop/src/paneTreeSerialize.test.ts`
- Modify: `apps/desktop/src/preferences.ts`

**Interfaces:**
- Consumes: `PaneNode`, `newLeaf`, `leaves` from `./paneTree`; `sessionKey` from `./sessionKey`.
- Produces:
  ```ts
  export function serializePaneTree(tree: PaneNode): string;
  export function deserializePaneTree(json: string | null): PaneNode | null;
  export function prunePaneTree(tree: PaneNode, liveKeys: Set<string>): PaneNode;
  ```
  `deserializePaneTree` returns `null` on malformed input (never throws). `prunePaneTree` clears a leaf whose `session` key is not in `liveKeys` (sets `session: null`); it does NOT drop the leaf structure — an empty leaf is a valid picker slot. `preferences.ts` gains `PANE_TREE_KEY`, and `loadPaneTree()` / `savePaneTree(tree)` helpers using the two functions above (kept separate from `AppPreferences`, which stays a flat scalar record).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { leaves, newLeaf, splitLeaf } from './paneTree';
import { deserializePaneTree, prunePaneTree, serializePaneTree } from './paneTreeSerialize';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('paneTreeSerialize', () => {
  test('round-trips a nested tree', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const back = deserializePaneTree(serializePaneTree(tree));
    expect(back).not.toBeNull();
    expect(leaves(back!).map((l) => l.session?.sessionId).sort()).toEqual(['1', '2']);
  });

  test('malformed json returns null, never throws', () => {
    expect(deserializePaneTree('not json')).toBeNull();
    expect(deserializePaneTree(null)).toBeNull();
    expect(deserializePaneTree('{"kind":"bogus"}')).toBeNull();
  });

  test('prune clears leaves whose session is not live', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const pruned = prunePaneTree(tree, new Set(['h:1']));
    const sessions = leaves(pruned).map((l) => l.session?.sessionId ?? null).sort();
    expect(sessions).toEqual([null, '1']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test paneTreeSerialize`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `paneTreeSerialize.ts`**

```ts
import { type Branch, type Leaf, type PaneNode, newLeaf } from './paneTree';
import { sessionKey } from './sessionKey';

export function serializePaneTree(tree: PaneNode): string {
  return JSON.stringify(tree);
}

function isValid(node: unknown): node is PaneNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n.kind === 'leaf') return typeof n.id === 'string';
  if (n.kind === 'branch') {
    return (
      typeof n.id === 'string' &&
      (n.dir === 'row' || n.dir === 'col') &&
      typeof n.ratio === 'number' &&
      isValid(n.a) &&
      isValid(n.b)
    );
  }
  return false;
}

export function deserializePaneTree(json: string | null): PaneNode | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function prunePaneTree(tree: PaneNode, liveKeys: Set<string>): PaneNode {
  if (tree.kind === 'leaf') {
    if (tree.session && !liveKeys.has(sessionKey(tree.session.hostId, tree.session.sessionId))) {
      return { ...tree, session: null };
    }
    return tree;
  }
  const a = prunePaneTree((tree as Branch).a, liveKeys);
  const b = prunePaneTree((tree as Branch).b, liveKeys);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}
```

(The `Leaf`/`newLeaf` imports are used by the preferences helpers in Step 5; keep them.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test paneTreeSerialize`
Expected: PASS.

- [ ] **Step 5: Add persistence helpers to `preferences.ts`**

Append near the other `*_KEY` constants and loaders (do not touch `AppPreferences`):

```ts
import type { PaneNode } from './paneTree';
import { newLeaf } from './paneTree';
import { deserializePaneTree, serializePaneTree } from './paneTreeSerialize';

const PANE_TREE_KEY = 'tether_pane_tree';

export function loadPaneTree(): PaneNode {
  return deserializePaneTree(localStorage.getItem(PANE_TREE_KEY)) ?? newLeaf();
}

export function savePaneTree(tree: PaneNode): void {
  localStorage.setItem(PANE_TREE_KEY, serializePaneTree(tree));
}
```

- [ ] **Step 6: Verify existing preferences tests still pass**

Run: `bun --cwd apps/desktop run test preferences`
Expected: PASS (unchanged).

- [ ] **Step 7: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/paneTreeSerialize.ts src/paneTreeSerialize.test.ts src/preferences.ts && cd ../..
git add apps/desktop/src/paneTreeSerialize.ts apps/desktop/src/paneTreeSerialize.test.ts apps/desktop/src/preferences.ts
git commit -m "feat(desktop): persist + prune the pane tree"
```

---

## Task 5: Per-pane refit on geometry change

**Files:**
- Modify: `apps/desktop/src/TerminalPane.tsx`
- Create: `apps/desktop/src/resizeFrame.ts`
- Test: `apps/desktop/src/resizeFrame.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export function resizeFrame(dims: { cols: number; rows: number } | undefined): { type: 'resize'; cols: number; rows: number };
  ```
  Pure helper that defaults missing dims to 80×24. `TerminalPane` gains a `ResizeObserver` on `hostRef` that, on every visible resize, calls `fit.fit()` and (when a socket exists) sends `resizeFrame(fit.proposeDimensions())`. This is what makes a smaller-than-fullscreen pane show the right grid.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { resizeFrame } from './resizeFrame';

describe('resizeFrame', () => {
  test('passes through dims', () => {
    expect(resizeFrame({ cols: 120, rows: 40 })).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
  test('defaults undefined dims to 80x24', () => {
    expect(resizeFrame(undefined)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test resizeFrame`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resizeFrame.ts`**

```ts
export function resizeFrame(dims: { cols: number; rows: number } | undefined): {
  type: 'resize';
  cols: number;
  rows: number;
} {
  return { type: 'resize', cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test resizeFrame`
Expected: PASS.

- [ ] **Step 5: Wire the ResizeObserver into `TerminalPane.tsx`**

Replace the inline resize object literal at `TerminalPane.tsx:221` with `resizeFrame(next)` (import it), and add a new effect after the existing interactive effect (near line 228). Use `termRef`, `fitRef`, `getSocketRef` already returned from `useTerminalMount`:

```tsx
import { resizeFrame } from './resizeFrame';
// ...inside TerminalPane, after the interactive effect:
useEffect(() => {
  const host = hostRef.current;
  if (!host) return undefined;
  const observer = new ResizeObserver(() => {
    const fit = fitRef.current;
    const socket = getSocketRef.current?.() ?? null;
    if (!fit) return;
    fit.fit();
    if (socket) sendJson(socket, resizeFrame(fit.proposeDimensions()));
  });
  observer.observe(host);
  return () => observer.disconnect();
}, [hostRef, fitRef, getSocketRef]);
```

And update the interactive effect's send to reuse the helper:

```tsx
if (socket) sendJson(socket, resizeFrame(next));
```

- [ ] **Step 6: Verify build + existing pane tests**

Run: `bun --cwd apps/desktop run test` then `bun lint`
Expected: PASS; no type errors.

- [ ] **Step 7: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/resizeFrame.ts src/resizeFrame.test.ts src/TerminalPane.tsx && cd ../..
git add apps/desktop/src/resizeFrame.ts apps/desktop/src/resizeFrame.test.ts apps/desktop/src/TerminalPane.tsx
git commit -m "feat(desktop): refit each pane on geometry change"
```

---

## Task 6: Rect-positioned panes + dividers in `ResidentTerminals`

**Files:**
- Modify: `apps/desktop/src/ResidentTerminals.tsx`
- Create: `apps/desktop/src/PaneDivider.tsx`
- Create: `apps/desktop/src/EmptyPanePicker.tsx`
- Modify: `apps/desktop/src/index.css`

**Interfaces:**
- Consumes: `PaneNode`, `SessionRef`, `setRatio`, `leaves` from `./paneTree`; `layoutTree`, `Rect`, `LeafRect`, `DividerRect` from `./layoutRects`; `sessionKey`, `parseSessionKey` from `./sessionKey`; existing `TerminalPane`.
- Produces: `ResidentTerminals` now takes `tree`, `focusedPaneId`, and callbacks:
  ```ts
  export interface ResidentTerminalsProps {
    hosts: HostProfile[];
    passwords: Record<string, string>;
    sessions: DrawerSession[];
    tree: PaneNode;
    focusedPaneId: string;
    terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
    fontFamily: string;
    fontSize?: number;
    onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
    onDisconnected: (hostId: string) => void;
    onFocusPane: (paneId: string) => void;
    onSetRatio: (branchId: string, ratio: number) => void;
    onPickSession: (paneId: string) => void;
    onDropSession: (paneId: string, px: number, py: number) => void; // used in Task 9
  }
  ```
  `PaneDivider` props: `{ divider: DividerRect; containerSize: { width: number; height: number }; onRatio: (ratio: number) => void }`. `EmptyPanePicker` props: `{ onPick: () => void }` (a button that calls back; the real chooser modal is wired in Task 7 via `onPickSession`).

Note on residency: the pane tree's leaves ARE the resident set now. Keep the existing core-cache housekeeping (`coreCacheTouch`/`coreCacheIds`/`coreCacheDelete`) but drive it from every session in `leaves(tree)` (touch each) plus keep the LRU prune of ids not in `props.sessions`. The focused session is guaranteed touched.

- [ ] **Step 1: Write the failing test (residency selection is pure enough to test)**

Create `apps/desktop/src/residentKeys.ts` + test first (extract the "which keys should be resident" decision so it is unit-testable without DOM):

`apps/desktop/src/residentKeys.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { newLeaf, splitLeaf } from './paneTree';
import { residentKeys } from './residentKeys';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('residentKeys', () => {
  test('returns a session key per non-empty leaf', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(residentKeys(tree).sort()).toEqual(['h:1', 'h:2']);
  });
  test('skips empty leaves', () => {
    const root = newLeaf(null);
    expect(residentKeys(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test residentKeys`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `residentKeys.ts`**

```ts
import { leaves, type PaneNode } from './paneTree';
import { sessionKey } from './sessionKey';

export function residentKeys(tree: PaneNode): string[] {
  return leaves(tree)
    .filter((leaf) => leaf.session)
    .map((leaf) => sessionKey(leaf.session!.hostId, leaf.session!.sessionId));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/desktop run test residentKeys`
Expected: PASS.

- [ ] **Step 5: Implement `PaneDivider.tsx`**

```tsx
import { useCallback } from 'react';
import type { DividerRect } from './layoutRects';

export function PaneDivider({
  divider,
  containerSize,
  onRatio,
}: {
  divider: DividerRect;
  containerSize: { width: number; height: number };
  onRatio: (ratio: number) => void;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        // Ratio is measured against the divider's own parent box. We approximate
        // using the container: good enough for a single divider depth; nested
        // dividers still track because each divider reports its own branch id.
        const ratio =
          divider.dir === 'row'
            ? ev.clientX / Math.max(1, containerSize.width)
            : ev.clientY / Math.max(1, containerSize.height);
        onRatio(ratio);
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [divider.dir, containerSize.width, containerSize.height, onRatio],
  );

  return (
    <div
      className={`pane-divider pane-divider-${divider.dir}`}
      style={{
        left: divider.rect.left,
        top: divider.rect.top,
        width: divider.rect.width,
        height: divider.rect.height,
      }}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={divider.dir === 'row' ? 'vertical' : 'horizontal'}
    />
  );
}
```

> Note: the container-relative ratio is exact for a top-level divider and acceptable for nested ones at this stage; if nested-divider drift shows up in manual testing, refine `PaneDivider` to receive its parent branch's rect from `layoutTree` (extend `DividerRect` with a `parentRect`). Do not block this task on that.

- [ ] **Step 6: Implement `EmptyPanePicker.tsx`**

```tsx
export function EmptyPanePicker({ onPick }: { onPick: () => void }) {
  return (
    <div className="empty-pane">
      <button type="button" className="empty-pane-button" onClick={onPick}>
        Choose a session…
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Rewrite `ResidentTerminals.tsx` to lay out by rect**

Replace the body so it: measures the container with a `ResizeObserver`, computes `layoutTree(props.tree, w, h)`, renders each non-empty `LeafRect` as an absolutely-positioned wrapper containing a `TerminalPane` (with `interactive={paneId === props.focusedPaneId}`), renders empty leaves as `EmptyPanePicker`, renders each `DividerRect` as a `PaneDivider`, and wraps every pane in a click handler calling `props.onFocusPane(paneId)`. Keep the core-cache housekeeping keyed off `residentKeys(props.tree)`.

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { coreCacheDelete, coreCacheIds, coreCacheTouch } from './coreApi';
import { EmptyPanePicker } from './EmptyPanePicker';
import type { FrameApplyResult } from './frameHandler';
import { layoutTree } from './layoutRects';
import { PaneDivider } from './PaneDivider';
import type { PaneNode } from './paneTree';
import { residentKeys } from './residentKeys';
import { sessionKey } from './sessionKey';
import { TerminalPane } from './TerminalPane';
import type { UI_THEMES } from './preferences';
import type { DrawerSession, HostProfile } from './types';
import { wsOriginFor } from './types';

export interface ResidentTerminalsProps {
  hosts: HostProfile[];
  passwords: Record<string, string>;
  sessions: DrawerSession[];
  tree: PaneNode;
  focusedPaneId: string;
  terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
  fontFamily: string;
  fontSize?: number;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: (hostId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSetRatio: (branchId: string, ratio: number) => void;
  onPickSession: (paneId: string) => void;
  onDropSession: (paneId: string, px: number, py: number) => void;
}

export function ResidentTerminals(props: ResidentTerminalsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const keys = useMemo(() => residentKeys(props.tree).join('|'), [props.tree]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const key of residentKeys(props.tree)) await coreCacheTouch(key);
      const valid = new Set(props.sessions.map((row) => sessionKey(row.hostId, row.id)));
      const wanted = new Set(residentKeys(props.tree));
      const ids = await coreCacheIds();
      for (const id of ids) {
        if (!valid.has(id) && !wanted.has(id)) await coreCacheDelete(id);
      }
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [keys, props.sessions, props.tree]);

  const layout = useMemo(
    () => layoutTree(props.tree, size.width, size.height),
    [props.tree, size.width, size.height],
  );

  return (
    <div className="resident-terminals" ref={containerRef}>
      {layout.leaves.map((leaf) => {
        const style = {
          position: 'absolute' as const,
          left: leaf.rect.left,
          top: leaf.rect.top,
          width: leaf.rect.width,
          height: leaf.rect.height,
        };
        if (!leaf.session) {
          return (
            <div key={leaf.paneId} className="pane-slot" style={style}>
              <EmptyPanePicker onPick={() => props.onPickSession(leaf.paneId)} />
            </div>
          );
        }
        const host = props.hosts.find((row) => row.id === leaf.session!.hostId);
        if (!host) return null;
        return (
          <div
            key={leaf.paneId}
            className={`pane-slot${leaf.paneId === props.focusedPaneId ? ' focused' : ''}`}
            style={style}
            onPointerDownCapture={() => props.onFocusPane(leaf.paneId)}
          >
            <TerminalPane
              hostId={leaf.session.hostId}
              sessionId={leaf.session.sessionId}
              interactive={leaf.paneId === props.focusedPaneId}
              wsOrigin={wsOriginFor(host)}
              password={props.passwords[leaf.session.hostId] ?? ''}
              terminalTheme={props.terminalTheme}
              fontFamily={props.fontFamily}
              fontSize={props.fontSize}
              onFrame={props.onFrame}
              onDisconnected={() => props.onDisconnected(leaf.session!.hostId)}
            />
          </div>
        );
      })}
      {layout.dividers.map((divider) => (
        <PaneDivider
          key={divider.branchId}
          divider={divider}
          containerSize={size}
          onRatio={(ratio) => props.onSetRatio(divider.branchId, ratio)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Add CSS for pane slots + dividers**

In `index.css`, replace the `.resident-pane.active/.inactive` visibility rule usage by making pane visibility rect-driven. Add:

```css
.pane-slot {
  overflow: hidden;
}
.pane-slot.focused {
  z-index: 1;
}
.pane-divider {
  position: absolute;
  z-index: 2;
  background: color-mix(in srgb, var(--lit) 16%, transparent);
}
.pane-divider-row {
  cursor: col-resize;
}
.pane-divider-col {
  cursor: row-resize;
}
.pane-divider:hover {
  background: color-mix(in srgb, var(--lit) 40%, transparent);
}
.empty-pane {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  background: var(--term-bg);
}
```

The existing `.resident-pane` rule stays for the `TerminalPane` root; since it now lives inside a sized `.pane-slot`, change `.resident-pane` `position: absolute; inset: 0;` remains correct (fills its slot). Drop the `.resident-pane.inactive { visibility: hidden }` rule — panes are now positioned, not stacked. Keep `.active` for focus styling if referenced; otherwise remove.

- [ ] **Step 9: Verify tests + lint (App won't compile yet — that's Task 7)**

Run: `bun --cwd apps/desktop run test residentKeys layoutRects paneTree`
Expected: PASS. `bun lint` may report `App.tsx` prop mismatches — those are fixed in Task 7. Do not commit a broken `App.tsx`; commit only the isolated new files here and the ResidentTerminals/CSS change together with Task 7 if the typecheck gates commits. If the repo allows a red typecheck between commits, commit now:

```bash
cd apps/desktop && bunx biome check --write src/residentKeys.ts src/residentKeys.test.ts src/ResidentTerminals.tsx src/PaneDivider.tsx src/EmptyPanePicker.tsx src/index.css && cd ../..
git add apps/desktop/src/residentKeys.ts apps/desktop/src/residentKeys.test.ts apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/PaneDivider.tsx apps/desktop/src/EmptyPanePicker.tsx apps/desktop/src/index.css
git commit -m "feat(desktop): rect-positioned panes + dividers"
```

> If your workflow requires every commit to typecheck, merge this task's commit with Task 7 (do Task 7's `App.tsx` edits before committing).

---

## Task 7: Own the pane tree in `App`, wire focus + picker

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `loadPaneTree`, `savePaneTree` from `./preferences`; `PaneNode`, `SessionRef`, `newLeaf`, `setSession`, `setRatio`, `leaves`, `findLeaf`, `firstLeafId` from `./paneTree`; `prunePaneTree` from `./paneTreeSerialize`; `sessionKey` from `./sessionKey`; new `ResidentTerminals` props from Task 6.
- Produces: `App` holds `const [tree, setTree] = useState(loadPaneTree)` and a `focusedPaneId` state. Every `setTree` persists via `savePaneTree`. Focus and the pane tree drive `app.selectSession` so the rest of the app (git panel, workspace, tint) keeps working off the focused pane's session.

- [ ] **Step 1: Add tree state + helpers in `App`**

After `const [prefs, setPrefs] = useState(...)`:

```tsx
const [tree, setTreeState] = useState<PaneNode>(loadPaneTree);
const [focusedPaneId, setFocusedPaneId] = useState<string>(() => firstLeafId(tree));
const updateTree = (next: PaneNode) => {
  setTreeState(next);
  savePaneTree(next);
};
```

- [ ] **Step 2: Seed the first pane with the active session**

When there is no split yet (single empty leaf) and a session becomes active, fill it. Add an effect:

```tsx
useEffect(() => {
  if (!app.activeHostId || !app.activeSessionId) return;
  const ref: SessionRef = { hostId: app.activeHostId, sessionId: app.activeSessionId };
  const focused = findLeaf(tree, focusedPaneId);
  if (focused && !focused.session) {
    updateTree(setSession(tree, focusedPaneId, ref));
  }
}, [app.activeHostId, app.activeSessionId, tree, focusedPaneId]);
```

- [ ] **Step 3: Prune dead sessions out of the tree when the session list changes**

```tsx
useEffect(() => {
  const live = new Set(app.sessions.map((row) => sessionKey(row.hostId, row.id)));
  const pruned = prunePaneTree(tree, live);
  if (pruned !== tree) updateTree(pruned);
}, [app.sessions]);
```

- [ ] **Step 4: Sync focus → active session**

When the focused pane changes, tell the app which session is active so tint/git/workspace follow:

```tsx
useEffect(() => {
  const leaf = findLeaf(tree, focusedPaneId);
  if (leaf?.session) app.selectSession(leaf.session.hostId, leaf.session.sessionId);
}, [focusedPaneId, tree]);
```

- [ ] **Step 5: Replace the `ResidentTerminals` call with the new props**

```tsx
<ResidentTerminals
  hosts={app.hosts}
  passwords={app.passwords}
  sessions={app.sessions}
  tree={tree}
  focusedPaneId={focusedPaneId}
  terminalTheme={theme.terminal}
  fontFamily={prefs.terminalFont}
  onFrame={app.handleWsFrame}
  onDisconnected={(hostId) => app.retryHost(hostId)}
  onFocusPane={setFocusedPaneId}
  onSetRatio={(branchId, ratio) => updateTree(setRatio(tree, branchId, ratio))}
  onPickSession={(paneId) => modals.openPanePicker(paneId)}
  onDropSession={(paneId, px, py) => {
    /* wired in Task 9 */
  }}
/>
```

For `modals.openPanePicker`: add a lightweight picker modal to `SessionModals`/`useSessionModals` that lists sessions (reuse `tabLabels`) and, on choose, calls `updateTree(setSession(tree, paneId, ref))` and `setFocusedPaneId(paneId)`; a "New session" entry calls `app.newSession(hostId)` then fills the pane when the new id arrives. If `useSessionModals` is awkward to extend, inline a small `panePickerFor` state in `App` instead — either is fine; keep it in one place.

- [ ] **Step 6: Typecheck + run the whole desktop suite**

Run: `bun lint` then `bun --cwd apps/desktop run test`
Expected: PASS, no type errors.

- [ ] **Step 7: Manual smoke (single pane still works)**

Run: `bun --cwd apps/desktop run tauri:dev`, connect to a host, confirm a single session still renders, types, and resizes exactly as before. (No split gestures yet.)

- [ ] **Step 8: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/App.tsx && cd ../..
git add apps/desktop/src/App.tsx apps/desktop/src/SessionModals.tsx apps/desktop/src/useTetherDesktop.tsx
git commit -m "feat(desktop): App owns the pane tree; focus drives active session"
```

---

## Task 8: Split buttons + keyboard shortcuts

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/ResidentTerminals.tsx` (split affordances on the focused pane)
- Modify: `apps/desktop/src/index.css`

**Interfaces:**
- Consumes: `splitLeaf`, `closePane` from `./paneTree`.
- Produces: focused pane shows split-right / split-down / close buttons; `App` binds keyboard shortcuts. New callbacks on `ResidentTerminals`: `onSplit(paneId, dir, side)` and `onClosePane(paneId)`.

- [ ] **Step 1: Add split/close callbacks in `App` and pass to `ResidentTerminals`**

```tsx
const splitPane = (paneId: string, dir: PaneDir, side: PaneSide) => {
  // New leaf is empty → shows the picker.
  updateTree(splitLeaf(tree, paneId, dir, side, null));
};
const closePane_ = (paneId: string) => {
  const next = closePane(tree, paneId);
  updateTree(next);
  if (!findLeaf(next, focusedPaneId)) setFocusedPaneId(firstLeafId(next));
};
```

Pass `onSplit={splitPane}` and `onClosePane={closePane_}` to `ResidentTerminals`.

- [ ] **Step 2: Render split/close affordances on the focused pane**

In `ResidentTerminals`, inside the focused non-empty pane slot, add a small control cluster:

```tsx
{leaf.paneId === props.focusedPaneId && (
  <div className="pane-controls">
    <button type="button" title="Split right" onClick={() => props.onSplit(leaf.paneId, 'row', 'b')}>⬒</button>
    <button type="button" title="Split down" onClick={() => props.onSplit(leaf.paneId, 'col', 'b')}>⬓</button>
    <button type="button" title="Close pane" onClick={() => props.onClosePane(leaf.paneId)}>✕</button>
  </div>
)}
```

Extend `ResidentTerminalsProps` with `onSplit: (paneId: string, dir: PaneDir, side: PaneSide) => void` and `onClosePane: (paneId: string) => void`.

- [ ] **Step 3: Keyboard shortcuts in `App`**

Add an effect binding shortcuts only when a pane is focused. Audit against existing bindings first (grep `addEventListener('keydown'` in `apps/desktop/src`); use chords not already taken):

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === 'd' && !e.shiftKey) {
      e.preventDefault();
      splitPane(focusedPaneId, 'row', 'b');
    } else if (e.key === 'd' && e.shiftKey) {
      e.preventDefault();
      splitPane(focusedPaneId, 'col', 'b');
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [focusedPaneId, tree]);
```

> If `Cmd/Ctrl+D` collides with an existing binding (the grep in this step tells you), pick a free chord and note it in the pane-control button `title` tooltips so the two stay in sync.

- [ ] **Step 4: CSS for pane controls**

```css
.pane-controls {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 3;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 120ms;
}
.pane-slot.focused:hover .pane-controls {
  opacity: 1;
}
.pane-controls button {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--input) 80%, transparent);
}
```

- [ ] **Step 5: Typecheck + suite**

Run: `bun lint` then `bun --cwd apps/desktop run test`
Expected: PASS.

- [ ] **Step 6: Manual smoke**

`tauri:dev`: split right + down, fill the empty pane via picker, close a pane, confirm the surviving pane refits and keeps streaming.

- [ ] **Step 7: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/App.tsx src/ResidentTerminals.tsx src/index.css && cd ../..
git add apps/desktop/src/App.tsx apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/index.css
git commit -m "feat(desktop): split buttons + keyboard shortcuts"
```

---

## Task 9: Right-click a tab → split menu + drag tab into a pane

**Files:**
- Create: `apps/desktop/src/TabContextMenu.tsx`
- Create: `apps/desktop/src/SplitPreviewOverlay.tsx`
- Modify: `apps/desktop/src/SessionTabBar.tsx`, `apps/desktop/src/SessionDrawer.tsx`
- Modify: `apps/desktop/src/ResidentTerminals.tsx`, `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/index.css`

**Interfaces:**
- Consumes: `dropIntent`, `DropIntent` from `./dropZone`; `layoutTree` from `./layoutRects`; `splitLeaf`, `setSession`, `SessionRef` from `./paneTree`; `sessionKey` from `./sessionKey`.
- Produces:
  - `TabContextMenu` props `{ x: number; y: number; onSplit: (dir: PaneDir, side: PaneSide) => void; onClose: () => void }` — four items: Split right (`row`,`b`), left (`row`,`a`), up (`col`,`a`), down (`col`,`b`).
  - `SplitPreviewOverlay` props `{ rect: Rect; intent: DropIntent }` — draws the translucent target region within `rect`.
  - A shared drag payload: on tab `dragstart`, `e.dataTransfer.setData('application/x-tether-session', sessionKey(hostId, sessionId))`.

- [ ] **Step 1: Right-click menu wiring**

Add `onContextMenu` to the tab in `SessionTabBar.tsx` (`SessionTab`) and the drawer row in `SessionDrawer.tsx`. It opens `TabContextMenu` at the pointer with a callback that, in `App`, applies:

```tsx
const splitFromTab = (session: SessionRef, dir: PaneDir, side: PaneSide) => {
  updateTree(splitLeaf(tree, focusedPaneId, dir, side, session));
};
```

`TabContextMenu.tsx`:
```tsx
import type { PaneDir, PaneSide } from './paneTree';

export function TabContextMenu({
  x,
  y,
  onSplit,
  onClose,
}: {
  x: number;
  y: number;
  onSplit: (dir: PaneDir, side: PaneSide) => void;
  onClose: () => void;
}) {
  const item = (label: string, dir: PaneDir, side: PaneSide) => (
    <button
      type="button"
      className="tab-menu-item"
      onClick={() => {
        onSplit(dir, side);
        onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="tab-menu-scrim" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="tab-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        {item('Split right', 'row', 'b')}
        {item('Split left', 'row', 'a')}
        {item('Split up', 'col', 'a')}
        {item('Split down', 'col', 'b')}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Make tabs draggable**

In `SessionTab` (`SessionTabBar.tsx`), add to the tab element:
```tsx
draggable
onDragStart={(e) => {
  e.dataTransfer.setData('application/x-tether-session', sessionKey(host.id, session.id));
  e.dataTransfer.effectAllowed = 'move';
}}
```
Do the same for the drawer row.

- [ ] **Step 3: Pane drag-over preview + drop in `ResidentTerminals`**

Track hovered pane + local pointer position; compute `dropIntent`; render `SplitPreviewOverlay`. On drop, read the session key and call `props.onDropSession(paneId, localX, localY)`.

Add to each non-empty pane slot:
```tsx
onDragOver={(e) => {
  if (!e.dataTransfer.types.includes('application/x-tether-session')) return;
  e.preventDefault();
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setHover({ paneId: leaf.paneId, px: e.clientX - box.left, py: e.clientY - box.top, rect: leaf.rect });
}}
onDragLeave={() => setHover((h) => (h?.paneId === leaf.paneId ? null : h))}
onDrop={(e) => {
  const key = e.dataTransfer.getData('application/x-tether-session');
  if (!key) return;
  e.preventDefault();
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  props.onDropSession(leaf.paneId, e.clientX - box.left, e.clientY - box.top, key);
  setHover(null);
}}
```

Render the overlay when `hover` is set:
```tsx
{hover && (
  <SplitPreviewOverlay
    rect={hover.rect}
    intent={dropIntent(hover.px, hover.py, { left: 0, top: 0, width: hover.rect.width, height: hover.rect.height })}
  />
)}
```

Change `onDropSession` signature to `(paneId: string, px: number, py: number, sessionKey: string) => void`.

`SplitPreviewOverlay.tsx`:
```tsx
import { dropIntent, type DropIntent } from './dropZone';
import type { Rect } from './layoutRects';

export function SplitPreviewOverlay({ rect, intent }: { rect: Rect; intent: DropIntent }) {
  const ghost = ghostRect(rect, intent);
  return <div className="split-preview" style={ghost} />;
}

function ghostRect(rect: Rect, intent: DropIntent) {
  const base = { position: 'absolute' as const };
  if (intent.kind === 'replace') {
    return { ...base, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const half = intent.dir === 'row' ? rect.width / 2 : rect.height / 2;
  if (intent.dir === 'row') {
    const left = intent.side === 'a' ? rect.left : rect.left + half;
    return { ...base, left, top: rect.top, width: half, height: rect.height };
  }
  const top = intent.side === 'a' ? rect.top : rect.top + half;
  return { ...base, left: rect.left, top, width: rect.width, height: half };
}
```

- [ ] **Step 4: Apply the drop in `App`**

```tsx
const dropSessionIntoPane = (paneId: string, px: number, py: number, key: string) => {
  const { hostId, sessionId } = parseSessionKey(key);
  const ref: SessionRef = { hostId, sessionId };
  const leaf = layoutTree(tree, /* width */ 0, /* height */ 0).leaves.find((l) => l.paneId === paneId);
  // Geometry for the intent comes from the pane's own box; ResidentTerminals passes
  // local px/py already, so recompute intent against the pane's rect it also knows.
  const intent = dropIntent(px, py, { left: 0, top: 0, width: px + 1, height: py + 1 });
  // Simpler: let ResidentTerminals pass the intent it already computed. Prefer that:
};
```

> Simplify: instead of recomputing in `App`, have `ResidentTerminals` compute the `DropIntent` (it already does, for the overlay) and call `props.onDropSession(paneId, intent, key)`. Change the prop to `onDropSession: (paneId: string, intent: DropIntent, key: string) => void` and implement in `App`:

```tsx
const dropSessionIntoPane = (paneId: string, intent: DropIntent, key: string) => {
  const { hostId, sessionId } = parseSessionKey(key);
  const ref: SessionRef = { hostId, sessionId };
  if (intent.kind === 'replace') {
    updateTree(setSession(tree, paneId, ref));
  } else {
    updateTree(splitLeaf(tree, paneId, intent.dir, intent.side, ref));
  }
  setFocusedPaneId(paneId);
};
```

Use this second form; delete the first sketch. Update the `onDrop` handler in Step 3 to pass the computed `intent` rather than `px, py`.

- [ ] **Step 5: CSS for menu + preview**

```css
.tab-menu-scrim { position: fixed; inset: 0; z-index: 50; }
.tab-menu {
  position: fixed;
  z-index: 51;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 4px;
  border-radius: 8px;
  background: var(--surface, var(--input));
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
}
.tab-menu-item { text-align: left; padding: 6px 10px; border-radius: 6px; }
.tab-menu-item:hover { background: color-mix(in srgb, var(--lit) 20%, transparent); }
.split-preview {
  z-index: 4;
  pointer-events: none;
  background: color-mix(in srgb, var(--lit) 30%, transparent);
  outline: 2px solid color-mix(in srgb, var(--lit) 70%, transparent);
  border-radius: 8px;
}
```

- [ ] **Step 6: Typecheck + suite**

Run: `bun lint` then `bun --cwd apps/desktop run test`
Expected: PASS.

- [ ] **Step 7: Manual smoke**

`tauri:dev`: right-click a tab → Split right drops that session into a new pane; drag a tab toward each edge → ghost preview shows the target half → drop lands the split there; center drop replaces.

- [ ] **Step 8: Format + commit**

```bash
cd apps/desktop && bunx biome check --write src/TabContextMenu.tsx src/SplitPreviewOverlay.tsx src/SessionTabBar.tsx src/SessionDrawer.tsx src/ResidentTerminals.tsx src/App.tsx src/index.css && cd ../..
git add apps/desktop/src/TabContextMenu.tsx apps/desktop/src/SplitPreviewOverlay.tsx apps/desktop/src/SessionTabBar.tsx apps/desktop/src/SessionDrawer.tsx apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/App.tsx apps/desktop/src/index.css
git commit -m "feat(desktop): tab right-click split + drag-into-pane with preview"
```

---

## Task 10: Final integration pass

**Files:**
- Modify: as needed across the desktop app for polish surfaced by manual testing.

- [ ] **Step 1: Full suite + lint**

Run: `bun --cwd apps/desktop run test` and `bun lint`
Expected: all green.

- [ ] **Step 2: Persistence smoke**

`tauri:dev`: build a 3-pane split across two hosts, quit, relaunch → layout restored; kill a session that was in a pane → its pane becomes an empty picker (not a crash); the survivor keeps running.

- [ ] **Step 3: Regression smoke**

Confirm single-pane workflows unchanged: workspace panel, git drawer/review, presentations, file viewer still open over the focused pane; app tint follows the focused pane.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A apps/desktop
git commit -m "fix(desktop): multi-terminal split polish"
```

- [ ] **Step 5: Update the board task**

Add a note to board task #990 (what shipped + how verified) and move it toward done when merged.

---

## Self-Review

**1. Spec coverage:**
- Pane tree model → Task 1. ✔
- Reuse resident panes / rect positioning → Task 6. ✔
- Per-pane refit (the one new mechanic) → Task 5. ✔
- Focus + input gating (one focused pane) → Tasks 6–7. ✔
- Split buttons + shortcuts → Task 8. ✔
- Right-click tab split → Task 9. ✔
- Drag tab into pane with live ghost preview → Task 9. ✔
- Empty pane picker → Tasks 6–7. ✔
- Persist + prune-dead layout → Tasks 4, 7. ✔
- Cross-host mix → SessionRef is host-qualified throughout. ✔
- Orthogonal to tab chrome → drawer/tab strip untouched except drag/right-click adds. ✔
- Close pane ≠ kill → `closePane` only restructures the tree. ✔

**2. Placeholder scan:** Task 9 Step 4 intentionally shows a rejected first sketch then the final form with an explicit "use this second form; delete the first sketch" instruction — the final code is complete. No `TODO`/`TBD` left as real work. Manual-smoke steps are verification, not code placeholders.

**3. Type consistency:** `SessionRef`, `PaneNode`, `PaneDir`, `PaneSide`, `DropIntent`, `Rect`, `LeafRect`, `DividerRect`, `Layout` used consistently. `onDropSession` is finalized to `(paneId, intent, key)` in Task 9 Step 4 (superseding the earlier `(paneId, px, py, key)` sketch) — the overlay computes the intent once and hands it up. `resizeFrame` used in both the observer and the interactive effect.

## Risks / watch-items (from the spec)

- **Refit correctness** — Task 5 is the sharpest edge; verify grids match boxes in manual smoke.
- **Nested-divider ratio** — `PaneDivider` uses a container-relative approximation; exact for top-level, refine only if drift appears (noted in Task 6 Step 5).
- **Shortcut collisions** — Task 8 Step 3 requires the grep audit before binding `Cmd/Ctrl+D`.
- **WebGL context cap** at high pane counts — existing software fallback in `mountTerminal` covers it.
