# Desktop terminal groups (per-view layouts)

**Date:** 2026-09-04
**Status:** Design approved, pre-plan
**Scope:** `apps/desktop` only

## Problem

Today the desktop client holds a **single global pane tree** (`App.tsx`,
`tree: PaneNode`). A "split" drops a second session into that one shared
layout; the tab strip (`SessionTabBar`) is independent and renders every
session flat, one tab per session.

Consequence: there is no notion of a standalone terminal. Clicking a third
terminal's tab calls `openSession` → `fillPane(focusedPaneId)`, shoving that
session into the existing split instead of showing it on its own. A terminal
that was never split can never be viewed full-space once a split exists.

## Goal

A **split creates a group**. The layout shown depends on which tab is active:

- A terminal that is **not** in a group renders **full-space** (solo).
- A group renders its saved multi-pane split.
- The tab strip collapses a group into a **single tab** (e.g. `claude + shell`).

## Decisions (locked)

- **Tab strip:** group collapses to one tab. Strip shows solo tabs + group
  tabs, in view order.
- **Shrink to one:** a group that drops to a single pane collapses back to a
  solo tab. A group is *by definition* 2+ panes; there is no sticky one-member
  group.
- **Group label:** auto, joined member titles (truncated), e.g. `claude + shell`.
- **Cross-host:** allowed. A group may mix sessions from different hosts (the
  pane tree already stores `hostId` per leaf).

## Data model

Replace the single `tree` / `focusedPaneId` state with an **ordered list of
views**:

```ts
interface View {
  id: string;             // stable, crypto.randomUUID()
  tree: PaneNode;         // reuse existing paneTree.ts unchanged
  focusedPaneId: string;  // remembered per view
}
type Views = View[];      // tab strip renders these, in order
// plus: activeViewId: string
```

- **Solo tab** = a view whose `tree` is a single `Leaf` → renders full-space.
- **Group tab** = a view whose `tree` has 2+ leaves → renders the split.
- Group-ness is derived: `isGroup(view) = leaves(view.tree).length >= 2`.
  There is no separate group type or group id — the view *is* the group.
  Because of this, "shrink to one → solo" needs no special case: close a pane,
  the tree has one leaf, the tab is solo again.

`activeSessionId` (drives window colour via `--lit`, git panel, toolbar
label) = the session in the **active view's focused pane**. An empty focused
leaf (`session: null`) means no active session, exactly as today.

## The reconciler (core invariant)

One pure function runs after every mutation and after every server session-list
change. It enforces:

> **Every live session belongs to exactly one view leaf.**

```
reconcileViews(views, liveSessionKeys) -> views
  1. Dead leaves: any leaf whose session key is not in liveSessionKeys has its
     session cleared; if that leaves a branch with an empty extractable leaf,
     collapse per close semantics. (A solo empty leaf is kept — it is the
     EmptyPanePicker placeholder, same as today.)
  2. Duplicates: if a session key appears in more than one leaf across all
     views, keep the first occurrence (view order, then in-tree order), clear
     the rest.
  3. Orphans: any live session key present in NO leaf gets a new solo view
     appended (newSoloView).
  4. Empty views: a view whose tree is a single leaf with session === null AND
     is not the only view is pruned. Keep at least the behaviour where a fresh
     empty pane can exist to host the picker.
  5. activeViewId / focusedPaneId repair: if activeViewId no longer exists,
     fall back to the first view; if a view's focusedPaneId no longer resolves
     to a leaf, reset to firstLeafId(view.tree).
```

This single function replaces the two current effects in `App.tsx`:
- the seed effect (fill empty focused pane with active session), and
- the prune effect (`prunePaneTree` on session death).

Rationale: it makes the hard operations trivial and lossless —
- Kill a session → leaf dies → reconciler collapses/pops.
- Center-drop replace → displaced session becomes an orphan → reconciler gives
  it a solo tab. No terminal is ever lost.
- Close pane B in `[A+B]` → B orphaned (still alive) → pops to solo tab `[B]`,
  `[A+B]` collapses to `[A]`.

Edge cases the reconciler must be tested against: empty session list (keep one
empty solo view for the picker); a session appearing in two views after a race;
active view pruned; focused pane pruned; all sessions on one host dying while
another host stays live.

## Interactions (mapped to existing handlers in App.tsx)

| Action | Today | New behaviour |
|---|---|---|
| `+` new terminal (`newTerminalOn`) | fills focused pane | create a **new solo view**, activate it |
| Click tab (`openSession`) | loads into focused pane | set `activeViewId` to that view; restore its `focusedPaneId` |
| Right-click tab → split (`splitFromTab`) | splits the one tree | split active view's focused pane; **move** chosen session's leaf out of its old view into this one; old view reconciles |
| Drag tab onto pane edge (`dropSessionIntoPane`, split intent) | split | same move-into-view |
| Drag tab onto pane center (`dropSessionIntoPane`, replace intent) | overwrite | overwrite target leaf; displaced session → orphan → reconciler gives it a solo tab |
| Close **pane** (`closePane_`, X / keyboard) | removes pane | extract: session stays alive, orphan pops to solo, group collapses |
| Kill **tab** × (`onRequestKill`) | kills 1 session | solo: kill it. **group: confirm-kill all members** (modal lists them) |

New primitive: `moveSessionIntoView(views, sessionKey, targetViewId, splitOrReplaceOp)`
= remove the leaf carrying `sessionKey` from whichever view holds it, apply the
split/replace into the target view, then reconcile. Everything else stays
existing `paneTree.ts` ops (`splitLeaf`, `setSession`, `closePane`, `setRatio`).

**Kill separation preserved:** closing a pane never terminates a session (matches
current architecture — kill is the explicit `POST /api/sessions/kill` path). Only
the tab × and the kill action terminate.

## Tab strip UI (`SessionTabBar.tsx`)

- Stop mapping `sessions` flat (`hosts.flatMap(... sessions.filter ...)`). Map
  **views** in order.
- **Solo tab:** unchanged look — host colour chip, label, activity dot.
- **Group tab:**
  - label = joined member titles, truncated (`groupLabel(view, sessions, hosts)`),
    e.g. `claude + shell`.
  - **aggregate dot** = max severity among members, order
    `waiting > working > done > idle/active` (`aggregateDot`).
  - up to ~3 distinct host-colour chips (cross-host groups).
  - × = kill all members (routes through the existing confirm modal in
    `SessionModals`, listing members).
- `SessionTab` gains a solo/group variant (or a sibling `GroupTab`).

## Persistence + migration (`viewsSerialize.ts`)

- Serialize `{ views: [{ id, tree, focusedPaneId }], activeViewId }` to
  localStorage. Reuse the leaf/branch validation from
  `paneTreeSerialize.ts` (`isValid`).
- **Migration:** an existing single-tree payload (old shape) deserializes to a
  single view wrapping that tree, `focusedPaneId = firstLeafId(tree)`,
  `activeViewId` = its id. One-time, lossless — the user keeps whatever split
  they currently have (now as one group tab).
- Validation failure → `null` → App seeds a fresh empty solo view (existing
  `loadPaneTree` fallback behaviour, adapted).

## Modules + testing

New / changed files:

- **`viewModel.ts` (new, pure, no React):** `View` type, `isGroup`,
  `newSoloView`, `reconcileViews`, `moveSessionIntoView`, `groupLabel`,
  `aggregateDot`. This is where correctness lives — heavy unit tests
  (`viewModel.test.ts`), TDD, covering every reconciler edge case above.
- **`viewsSerialize.ts` (new):** serialize / deserialize / migrate, with tests
  (`viewsSerialize.test.ts`) including the old-single-tree migration path.
- **`paneTree.ts`:** untouched. Per-tree ops reused as-is.
- **`paneTreeSerialize.ts`:** `prunePaneTree` folds into the reconciler; keep
  `isValid` (imported by `viewsSerialize.ts`). `serialize/deserializePaneTree`
  may be retired or kept as a leaf helper.
- **`App.tsx`:** replace `tree` / `focusedPaneId` with `views` / `activeViewId`;
  the two effects become one `reconcileViews` effect keyed on the live session
  list; retarget `splitPane`, `closePane_`, `fillPane`, `openSession`,
  `newTerminalOn`, `splitFromTab`, `dropSessionIntoPane` to the active view.
- **`SessionTabBar.tsx`:** render views; solo/group tab variants.
- **`SplitPaneView` / drop overlay:** operate on the active view's tree.

## Risks

- `App.tsx` rewires a chunk of layout state. Mitigation: reconciler and
  serializer are pure and fully tested in isolation first (TDD), so the App
  change is mostly plumbing existing ops onto the active view.
- Group-tab × killing all members is a sharp gesture — must go through the
  confirm modal listing members; never silent.
- Reconciler must be idempotent (running it twice = running once) to avoid
  churn under React effect re-runs.

## Out of scope

- Editable/persistent group names (auto-label only).
- Reordering tabs by drag (unless already present; not part of this change).
- Any server / core / iOS change — desktop-only.
