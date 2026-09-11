# Desktop Frontend Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/desktop/src`'s 96 remaining flat files into 10 domain folders alongside the existing `agent/` and `git/`, group the four `noise_*.rs` modules in `src-tauri`, and give the workspace its own `CLAUDE.md`.

**Architecture:** Pure mechanical refactor — no behavior changes, and **no file is renamed**, only moved. Filenames keep their domain prefix, matching `agent/` (21 of 21 files) and keeping React component filenames in sync with their exports. Cross-domain imports go through the `@/*` alias already wired in Task 1; same-folder imports stay relative. The oracle after every task is the desktop `build` script plus the existing 279-test suite.

**Tech Stack:** Vite 6.4, React 19, TypeScript 7.0, Biome 2.5.9, `bun:test`, Tauri 2, Rust.

**Spec:** `docs/superpowers/specs/2026-09-11-desktop-reorg-design.md`

## Global Constraints

- **Zero behavior change.** Every commit is a move or an import-specifier edit. If a task needs logic edited to go green, stop — something moved wrong.
- **No file is renamed.** `terminalBind.ts` becomes `terminal/terminalBind.ts`, not `terminal/bind.ts`. The prefix stays.
- **Gate on `bun run --cwd apps/desktop build`, never a bare `typecheck`.** That script is `tsc --noEmit && vite build`. `tsc` resolves `@/` from tsconfig on its own, so a typecheck passes even when vite cannot resolve it — measured, see the spec's evidence table.
- **Put `run` before `--cwd`.** `bun run --cwd apps/desktop test` works; `bun --cwd apps/desktop run test` prints the script list and **exits 0 without running anything** (Bun 1.4.0).
- **Run `bun format` after every rewrite.** Changing `./x` to `@/domain/x` reorders imports under Biome's `organizeImports` assist, which is an error, not a warning.
- **Match `*.tsx`, not just `*.ts`.** Over half these files are `.tsx`; a `*.ts`-only glob silently skips them.
- Biome: 2-space, single quotes, semicolons, trailing commas, width 120.
- Comments: minimal — only a non-obvious "why" or a gotcha.
- **No `Co-Authored-By` trailers** in commit messages.
- Branch is `refactor/desktop-domain-layout`, **stacked on `refactor/server-domain-layout`** (PR #183), which reformatted most of `apps/desktop` at 120 columns. Do not rebase onto `main`.
- **Stage with `git add apps/desktop`, never `git add -A`.** Another Claude session shares this checkout and has edited `apps/server` mid-run; `-A` would sweep unrelated work into a move commit. This reorg touches nothing outside `apps/desktop` (`src-tauri` included), so a scoped add is also a check on itself: if `git status` still shows desktop changes after committing, something was missed.

## Setup: the helper script

Every domain task sources this. Write it once, before Task 2:

```bash
mkdir -p /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad
cat > /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh <<'HELPERS'
# Source from apps/desktop. Set EXCL to the folder(s) this task created.
TSX=( -name '*.ts' -o -name '*.tsx' )

fix_dangling() {
  for f in "$1"/*.ts "$1"/*.tsx; do
    [ -e "$f" ] || continue
    for mod in $(grep -o "from '\./[A-Za-z0-9_/]*'" "$f" | sed "s|from '\./||; s|'||" | sort -u); do
      [ -f "$1/$mod.ts" ] || [ -f "$1/$mod.tsx" ] || [ -f "$1/$mod" ] \
        || sed -i "s|from '\./$mod'|from '../$mod'|g" "$f"
    done
  done
}

# rewrite <old-basename> <new-alias-path>
# Covers `from '...'`, `import('...')` and `require('...')`.
# '#' is the sed delimiter — '|' would collide with the alternation.
rewrite() {
  find src -maxdepth 1 \( "${TSX[@]}" \) -print0 \
    | xargs -0 -r sed -i -E "s#(from |import\(|require\()'\./$1'#\1'@/$2'#g"
  find src -mindepth 2 -maxdepth 2 \( "${TSX[@]}" \) $EXCL -print0 \
    | xargs -0 -r sed -i -E "s#(from |import\(|require\()'\.\./$1'#\1'@/$2'#g"
}

# After fix_dangling: a '../<domain>/x' that points at a real domain folder
# resolves, but the convention is the alias. Normalize every one of them.
normalize_cross_domain() {
  for d in $(ls -d src/*/ | xargs -n1 basename); do
    find src -mindepth 2 -maxdepth 2 \( "${TSX[@]}" \) -not -path "src/$d/*" -print0 \
      | xargs -0 -r sed -i -E "s#(from |import\(|require\()'\.\./$d/#\1'@/$d/#g"
  done
}

audit() {
  echo "--- dangling relative imports in $* ---"
  for d in "$@"; do for f in "$d"/*.ts "$d"/*.tsx; do [ -e "$f" ] || continue
    for mod in $(grep -o "from '\./[A-Za-z0-9_/]*'" "$f" | sed "s|from '\./||; s|'||"); do
      [ -f "$d/$mod.ts" ] || [ -f "$d/$mod.tsx" ] || [ -f "$d/$mod" ] && continue
      echo "  $f -> ./$mod"
    done; done; done
  echo "--- runtime-resolved paths in $* ---"
  grep -rn "import\.meta\.\(dir\|url\)\|require('\.\|import('\." "$@" || echo "  (none)"
}
HELPERS
```

## Why this is simpler than the server reorg

Three of the traps from `2026-09-11-server-reorg.md` do not apply here, and one is new.

| | Server | Desktop |
|---|---|---|
| Renames | every file lost its prefix | **none** — paths only, so no intra-domain rename pass and no shadowed-import pass |
| Name collisions | `control/app.ts` vs root `app.ts` bit us | all 100 basenames are unique across the tree |
| `import.meta.dir` | broke every holder spawn, invisible to `tsc` | **does not occur anywhere** in this workspace |
| Alias | Bun read tsconfig natively | **vite does not** — needs `vite-tsconfig-paths`, and `tsc` passing proves nothing |

The one dynamic import in the workspace is `useTetherDesktop.tsx` → `./desktopNotifications` (Task 3 moves the target, Task 11 moves the importer). The generalized `rewrite` covers it; Task 11 verifies it explicitly.

---

### Task 1: `@/*` alias — ALREADY DONE

Completed and committed as `565d2484` before this plan was written. Recorded here so the sequence is complete and so a re-run does not redo it.

What landed:

- `apps/desktop/tsconfig.json` gained `"paths": { "@/*": ["./src/*"] }` — and deliberately **no `baseUrl`**, which TypeScript 7 removed (`TS5102`).
- `apps/desktop/vite.config.ts` gained `tsconfigPaths()` from `vite-tsconfig-paths@6.1.1` (dev dependency), so vite reads that same tsconfig instead of a duplicated `resolve.alias`.

Verified against all three consumers by switching one real import in `src/App.tsx` to `@/viewModel`: `tsc --noEmit` passed, `vite build` passed, and a throwaway `bun:test` importing `@/paneTree` passed. With the plugin removed, `tsc` still exited 0 while `vite build` failed with `Rollup failed to resolve import "@/viewModel"` — which is why every task below gates on the `build` script.

- [ ] **Step 1: Confirm it is in place before starting Task 2**

```bash
cd /home/samuelloranger/sites/tether
grep -A3 '"paths"' apps/desktop/tsconfig.json
grep -n 'tsconfigPaths' apps/desktop/vite.config.ts
bun run --cwd apps/desktop build >/dev/null && echo "alias wiring OK"
```

Expected: `@/*` → `./src/*`, `tsconfigPaths()` in the plugins array, and a clean build. If any is missing, re-apply from the spec's **Import alias — and the trap** section before continuing.

---

### Task 2: `core/`

The Tauri invoke surface, transport, error decoding and shared constants. First because `agent/` and `git/` both reach into it (`../coreTransport`, `../invokeError`), so fixing those two folders early means they are touched once rather than repeatedly.

**Files:**
- Move: 4 source + 1 test files from `apps/desktop/src/` into `apps/desktop/src/core/`
- Modify: every file importing them (rewritten to `@/core/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/core/<module>` for each of: `coreApi`, `coreTransport`, `invokeError`, `types`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/core
git mv "src/coreApi.ts" "src/core/coreApi.ts"
git mv "src/coreTransport.ts" "src/core/coreTransport.ts"
git mv "src/invokeError.ts" "src/core/invokeError.ts"
git mv "src/types.ts" "src/core/types.ts"
git mv "src/invokeError.test.ts" "src/core/invokeError.test.ts"
ls src/core | wc -l   # expect 5
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `core/` still import not-yet-moved modules as `./x`, which
now resolves inside `core/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/core
normalize_cross_domain
audit src/core
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/core/*'
rewrite coreApi core/coreApi
rewrite coreTransport core/coreTransport
rewrite invokeError core/invokeError
rewrite types core/types
```

- [ ] **Check: `agent/` and `git/` import two of these as `../coreTransport` and `../invokeError`.**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
grep -rn "from '\.\./core" src/agent src/git
```

Every hit must read `@/...` after Pass B. If one still reads `../` or `./`, fix it by hand.

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group core modules"
```

---

### Task 3: `platform/`

Native-shell concerns: titlebar, window controls, deep links, notifications, updater, theme, dialog. Second because `git/useGitPanel.ts` imports `../dialog` — the last of the three flat modules the existing domain folders depend on.

**Files:**
- Move: 11 source + 2 test files from `apps/desktop/src/` into `apps/desktop/src/platform/`
- Modify: every file importing them (rewritten to `@/platform/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/platform/<module>` for each of: `TitleBar`, `desktopNavigation`, `desktopNotifications`, `desktopUpdater`, `dialog`, `platform`, `titlebarChrome`, `useDeepLinks`, `useLaunchUpdateCheck`, `useWindowTheme`, `windowControls`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/platform
git mv "src/TitleBar.tsx" "src/platform/TitleBar.tsx"
git mv "src/desktopNavigation.ts" "src/platform/desktopNavigation.ts"
git mv "src/desktopNotifications.ts" "src/platform/desktopNotifications.ts"
git mv "src/desktopUpdater.ts" "src/platform/desktopUpdater.ts"
git mv "src/dialog.ts" "src/platform/dialog.ts"
git mv "src/platform.ts" "src/platform/platform.ts"
git mv "src/titlebarChrome.ts" "src/platform/titlebarChrome.ts"
git mv "src/useDeepLinks.ts" "src/platform/useDeepLinks.ts"
git mv "src/useLaunchUpdateCheck.ts" "src/platform/useLaunchUpdateCheck.ts"
git mv "src/useWindowTheme.ts" "src/platform/useWindowTheme.ts"
git mv "src/windowControls.ts" "src/platform/windowControls.ts"
git mv "src/dialog.test.ts" "src/platform/dialog.test.ts"
git mv "src/titlebarChrome.test.ts" "src/platform/titlebarChrome.test.ts"
ls src/platform | wc -l   # expect 13
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `platform/` still import not-yet-moved modules as `./x`, which
now resolves inside `platform/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/platform
normalize_cross_domain
audit src/platform
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/platform/*'
rewrite TitleBar platform/TitleBar
rewrite desktopNavigation platform/desktopNavigation
rewrite desktopNotifications platform/desktopNotifications
rewrite desktopUpdater platform/desktopUpdater
rewrite dialog platform/dialog
rewrite platform platform/platform
rewrite titlebarChrome platform/titlebarChrome
rewrite useDeepLinks platform/useDeepLinks
rewrite useLaunchUpdateCheck platform/useLaunchUpdateCheck
rewrite useWindowTheme platform/useWindowTheme
rewrite windowControls platform/windowControls
```

- [ ] **Check: `git/useGitPanel.ts` imports `../dialog`.**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
grep -rn "from '\.\./dialog'" src/git
```

Every hit must read `@/...` after Pass B. If one still reads `../` or `./`, fix it by hand.

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group platform modules"
```

---

### Task 4: `terminal/`

Everything between xterm.js and the PTY socket: binding, clipboard, links, mouse, OSC, search, fit, frame handling, outbound gating, replay gate, paste.

**Files:**
- Move: 16 source + 8 test files from `apps/desktop/src/` into `apps/desktop/src/terminal/`
- Modify: every file importing them (rewritten to `@/terminal/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/terminal/<module>` for each of: `TerminalEmpty`, `TerminalPane`, `TerminalToolbar`, `fitTerminal`, `frameHandler`, `pasteBus`, `pastePayload`, `ptyOutbound`, `replayGate`, `resizeFrame`, `terminalBind`, `terminalClipboard`, `terminalLinks`, `terminalMouse`, `terminalOsc`, `terminalSearch`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/terminal
git mv "src/TerminalEmpty.tsx" "src/terminal/TerminalEmpty.tsx"
git mv "src/TerminalPane.tsx" "src/terminal/TerminalPane.tsx"
git mv "src/TerminalToolbar.tsx" "src/terminal/TerminalToolbar.tsx"
git mv "src/fitTerminal.ts" "src/terminal/fitTerminal.ts"
git mv "src/frameHandler.ts" "src/terminal/frameHandler.ts"
git mv "src/pasteBus.ts" "src/terminal/pasteBus.ts"
git mv "src/pastePayload.ts" "src/terminal/pastePayload.ts"
git mv "src/ptyOutbound.ts" "src/terminal/ptyOutbound.ts"
git mv "src/replayGate.ts" "src/terminal/replayGate.ts"
git mv "src/resizeFrame.ts" "src/terminal/resizeFrame.ts"
git mv "src/terminalBind.ts" "src/terminal/terminalBind.ts"
git mv "src/terminalClipboard.ts" "src/terminal/terminalClipboard.ts"
git mv "src/terminalLinks.ts" "src/terminal/terminalLinks.ts"
git mv "src/terminalMouse.ts" "src/terminal/terminalMouse.ts"
git mv "src/terminalOsc.ts" "src/terminal/terminalOsc.ts"
git mv "src/terminalSearch.tsx" "src/terminal/terminalSearch.tsx"
git mv "src/fitTerminal.test.ts" "src/terminal/fitTerminal.test.ts"
git mv "src/frameHandler.test.ts" "src/terminal/frameHandler.test.ts"
git mv "src/pastePayload.test.ts" "src/terminal/pastePayload.test.ts"
git mv "src/ptyOutbound.test.ts" "src/terminal/ptyOutbound.test.ts"
git mv "src/replayGate.test.ts" "src/terminal/replayGate.test.ts"
git mv "src/resizeFrame.test.ts" "src/terminal/resizeFrame.test.ts"
git mv "src/terminalLinks.test.ts" "src/terminal/terminalLinks.test.ts"
git mv "src/terminalMouse.test.ts" "src/terminal/terminalMouse.test.ts"
ls src/terminal | wc -l   # expect 24
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `terminal/` still import not-yet-moved modules as `./x`, which
now resolves inside `terminal/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/terminal
normalize_cross_domain
audit src/terminal
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/terminal/*'
rewrite TerminalEmpty terminal/TerminalEmpty
rewrite TerminalPane terminal/TerminalPane
rewrite TerminalToolbar terminal/TerminalToolbar
rewrite fitTerminal terminal/fitTerminal
rewrite frameHandler terminal/frameHandler
rewrite pasteBus terminal/pasteBus
rewrite pastePayload terminal/pastePayload
rewrite ptyOutbound terminal/ptyOutbound
rewrite replayGate terminal/replayGate
rewrite resizeFrame terminal/resizeFrame
rewrite terminalBind terminal/terminalBind
rewrite terminalClipboard terminal/terminalClipboard
rewrite terminalLinks terminal/terminalLinks
rewrite terminalMouse terminal/terminalMouse
rewrite terminalOsc terminal/terminalOsc
rewrite terminalSearch terminal/terminalSearch
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group terminal modules"
```

---

### Task 5: `session/`

Session tabs and their lifecycle: drawer, tab bar, modals, icons, key/label/list/lru/resume/strip, residency reconciliation, activity and lit state, tab drag.

**Files:**
- Move: 19 source + 13 test files from `apps/desktop/src/` into `apps/desktop/src/session/`
- Modify: every file importing them (rewritten to `@/session/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/session/<module>` for each of: `ResidentTerminals`, `SessionDrawer`, `SessionModals`, `SessionTabBar`, `TabContextMenu`, `activity`, `killConfirmCopy`, `litTheme`, `residencyReconcile`, `residentKeys`, `residentSessions`, `sessionIcons`, `sessionKey`, `sessionLabel`, `sessionList`, `sessionLru`, `sessionResume`, `sessionStrip`, `useTabDrag`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/session
git mv "src/ResidentTerminals.tsx" "src/session/ResidentTerminals.tsx"
git mv "src/SessionDrawer.tsx" "src/session/SessionDrawer.tsx"
git mv "src/SessionModals.tsx" "src/session/SessionModals.tsx"
git mv "src/SessionTabBar.tsx" "src/session/SessionTabBar.tsx"
git mv "src/TabContextMenu.tsx" "src/session/TabContextMenu.tsx"
git mv "src/activity.ts" "src/session/activity.ts"
git mv "src/killConfirmCopy.ts" "src/session/killConfirmCopy.ts"
git mv "src/litTheme.ts" "src/session/litTheme.ts"
git mv "src/residencyReconcile.ts" "src/session/residencyReconcile.ts"
git mv "src/residentKeys.ts" "src/session/residentKeys.ts"
git mv "src/residentSessions.ts" "src/session/residentSessions.ts"
git mv "src/sessionIcons.tsx" "src/session/sessionIcons.tsx"
git mv "src/sessionKey.ts" "src/session/sessionKey.ts"
git mv "src/sessionLabel.ts" "src/session/sessionLabel.ts"
git mv "src/sessionList.ts" "src/session/sessionList.ts"
git mv "src/sessionLru.ts" "src/session/sessionLru.ts"
git mv "src/sessionResume.ts" "src/session/sessionResume.ts"
git mv "src/sessionStrip.ts" "src/session/sessionStrip.ts"
git mv "src/useTabDrag.ts" "src/session/useTabDrag.ts"
git mv "src/activity.test.ts" "src/session/activity.test.ts"
git mv "src/killConfirmCopy.test.ts" "src/session/killConfirmCopy.test.ts"
git mv "src/litTheme.test.ts" "src/session/litTheme.test.ts"
git mv "src/residencyReconcile.test.ts" "src/session/residencyReconcile.test.ts"
git mv "src/residentKeys.test.ts" "src/session/residentKeys.test.ts"
git mv "src/residentSessions.test.ts" "src/session/residentSessions.test.ts"
git mv "src/sessionKey.test.ts" "src/session/sessionKey.test.ts"
git mv "src/sessionLabel.test.ts" "src/session/sessionLabel.test.ts"
git mv "src/sessionList.test.ts" "src/session/sessionList.test.ts"
git mv "src/sessionLru.test.ts" "src/session/sessionLru.test.ts"
git mv "src/sessionResume.test.ts" "src/session/sessionResume.test.ts"
git mv "src/sessionStrip.test.ts" "src/session/sessionStrip.test.ts"
git mv "src/useTabDrag.test.ts" "src/session/useTabDrag.test.ts"
ls src/session | wc -l   # expect 32
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `session/` still import not-yet-moved modules as `./x`, which
now resolves inside `session/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/session
normalize_cross_domain
audit src/session
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/session/*'
rewrite ResidentTerminals session/ResidentTerminals
rewrite SessionDrawer session/SessionDrawer
rewrite SessionModals session/SessionModals
rewrite SessionTabBar session/SessionTabBar
rewrite TabContextMenu session/TabContextMenu
rewrite activity session/activity
rewrite killConfirmCopy session/killConfirmCopy
rewrite litTheme session/litTheme
rewrite residencyReconcile session/residencyReconcile
rewrite residentKeys session/residentKeys
rewrite residentSessions session/residentSessions
rewrite sessionIcons session/sessionIcons
rewrite sessionKey session/sessionKey
rewrite sessionLabel session/sessionLabel
rewrite sessionList session/sessionList
rewrite sessionLru session/sessionLru
rewrite sessionResume session/sessionResume
rewrite sessionStrip session/sessionStrip
rewrite useTabDrag session/useTabDrag
```

- [ ] **Check: `ResidentTerminals.tsx` imports `./agent/AgentChatPane`; once it sits in `session/` that path is wrong.**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
grep -n "agent/AgentChatPane" src/session/ResidentTerminals.tsx
```

Every hit must read `@/...` after Pass B. If one still reads `../` or `./`, fix it by hand.

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group session modules"
```

---

### Task 6: `pane/`

The tiling layout: pane tree, its serialization, layout rects, drop zones, pane pickers, split preview.

**Files:**
- Move: 11 source + 6 test files from `apps/desktop/src/` into `apps/desktop/src/pane/`
- Modify: every file importing them (rewritten to `@/pane/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/pane/<module>` for each of: `EmptyPanePicker`, `PaneControls`, `PaneDivider`, `PanePickerModal`, `SplitPreviewOverlay`, `dropZone`, `layoutRects`, `paneTree`, `paneTreeSerialize`, `viewModel`, `viewsSerialize`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/pane
git mv "src/EmptyPanePicker.tsx" "src/pane/EmptyPanePicker.tsx"
git mv "src/PaneControls.tsx" "src/pane/PaneControls.tsx"
git mv "src/PaneDivider.tsx" "src/pane/PaneDivider.tsx"
git mv "src/PanePickerModal.tsx" "src/pane/PanePickerModal.tsx"
git mv "src/SplitPreviewOverlay.tsx" "src/pane/SplitPreviewOverlay.tsx"
git mv "src/dropZone.ts" "src/pane/dropZone.ts"
git mv "src/layoutRects.ts" "src/pane/layoutRects.ts"
git mv "src/paneTree.ts" "src/pane/paneTree.ts"
git mv "src/paneTreeSerialize.ts" "src/pane/paneTreeSerialize.ts"
git mv "src/viewModel.ts" "src/pane/viewModel.ts"
git mv "src/viewsSerialize.ts" "src/pane/viewsSerialize.ts"
git mv "src/dropZone.test.ts" "src/pane/dropZone.test.ts"
git mv "src/layoutRects.test.ts" "src/pane/layoutRects.test.ts"
git mv "src/paneTree.test.ts" "src/pane/paneTree.test.ts"
git mv "src/paneTreeSerialize.test.ts" "src/pane/paneTreeSerialize.test.ts"
git mv "src/viewModel.test.ts" "src/pane/viewModel.test.ts"
git mv "src/viewsSerialize.test.ts" "src/pane/viewsSerialize.test.ts"
ls src/pane | wc -l   # expect 17
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `pane/` still import not-yet-moved modules as `./x`, which
now resolves inside `pane/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/pane
normalize_cross_domain
audit src/pane
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/pane/*'
rewrite EmptyPanePicker pane/EmptyPanePicker
rewrite PaneControls pane/PaneControls
rewrite PaneDivider pane/PaneDivider
rewrite PanePickerModal pane/PanePickerModal
rewrite SplitPreviewOverlay pane/SplitPreviewOverlay
rewrite dropZone pane/dropZone
rewrite layoutRects pane/layoutRects
rewrite paneTree pane/paneTree
rewrite paneTreeSerialize pane/paneTreeSerialize
rewrite viewModel pane/viewModel
rewrite viewsSerialize pane/viewsSerialize
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group pane modules"
```

---

### Task 7: `host/`

Multi-host and pairing: host/device/pairing screens, address parsing, pairing codes, the noise host store and token, fingerprints.

**Files:**
- Move: 12 source + 8 test files from `apps/desktop/src/` into `apps/desktop/src/host/`
- Modify: every file importing them (rewritten to `@/host/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/host/<module>` for each of: `DevicesScreen`, `HostsScreen`, `PairDeviceScreen`, `address`, `devicesText`, `groupFingerprint`, `hostRecovery`, `hostScheme`, `noiseHosts`, `noiseToken`, `pairAddress`, `pairingCode`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/host
git mv "src/DevicesScreen.tsx" "src/host/DevicesScreen.tsx"
git mv "src/HostsScreen.tsx" "src/host/HostsScreen.tsx"
git mv "src/PairDeviceScreen.tsx" "src/host/PairDeviceScreen.tsx"
git mv "src/address.ts" "src/host/address.ts"
git mv "src/devicesText.ts" "src/host/devicesText.ts"
git mv "src/groupFingerprint.ts" "src/host/groupFingerprint.ts"
git mv "src/hostRecovery.ts" "src/host/hostRecovery.ts"
git mv "src/hostScheme.ts" "src/host/hostScheme.ts"
git mv "src/noiseHosts.ts" "src/host/noiseHosts.ts"
git mv "src/noiseToken.ts" "src/host/noiseToken.ts"
git mv "src/pairAddress.ts" "src/host/pairAddress.ts"
git mv "src/pairingCode.ts" "src/host/pairingCode.ts"
git mv "src/devicesText.test.ts" "src/host/devicesText.test.ts"
git mv "src/groupFingerprint.test.ts" "src/host/groupFingerprint.test.ts"
git mv "src/hostRecovery.test.ts" "src/host/hostRecovery.test.ts"
git mv "src/hostScheme.test.ts" "src/host/hostScheme.test.ts"
git mv "src/noiseHosts.test.ts" "src/host/noiseHosts.test.ts"
git mv "src/noiseToken.test.ts" "src/host/noiseToken.test.ts"
git mv "src/pairAddress.test.ts" "src/host/pairAddress.test.ts"
git mv "src/pairingCode.test.ts" "src/host/pairingCode.test.ts"
ls src/host | wc -l   # expect 20
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `host/` still import not-yet-moved modules as `./x`, which
now resolves inside `host/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/host
normalize_cross_domain
audit src/host
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/host/*'
rewrite DevicesScreen host/DevicesScreen
rewrite HostsScreen host/HostsScreen
rewrite PairDeviceScreen host/PairDeviceScreen
rewrite address host/address
rewrite devicesText host/devicesText
rewrite groupFingerprint host/groupFingerprint
rewrite hostRecovery host/hostRecovery
rewrite hostScheme host/hostScheme
rewrite noiseHosts host/noiseHosts
rewrite noiseToken host/noiseToken
rewrite pairAddress host/pairAddress
rewrite pairingCode host/pairingCode
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group host modules"
```

---

### Task 8: `workspace/`

The file tree, viewer, syntax highlighting and the workspace API surface.

**Files:**
- Move: 9 source + 2 test files from `apps/desktop/src/` into `apps/desktop/src/workspace/`
- Modify: every file importing them (rewritten to `@/workspace/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/workspace/<module>` for each of: `CodeHighlight`, `FileTree`, `FileViewer`, `fileOpenBus`, `useWorkspace`, `useWorkspaceFiles`, `workspaceApi`, `workspaceDirLogic`, `workspaceTypes`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/workspace
git mv "src/CodeHighlight.tsx" "src/workspace/CodeHighlight.tsx"
git mv "src/FileTree.tsx" "src/workspace/FileTree.tsx"
git mv "src/FileViewer.tsx" "src/workspace/FileViewer.tsx"
git mv "src/fileOpenBus.ts" "src/workspace/fileOpenBus.ts"
git mv "src/useWorkspace.tsx" "src/workspace/useWorkspace.tsx"
git mv "src/useWorkspaceFiles.ts" "src/workspace/useWorkspaceFiles.ts"
git mv "src/workspaceApi.ts" "src/workspace/workspaceApi.ts"
git mv "src/workspaceDirLogic.ts" "src/workspace/workspaceDirLogic.ts"
git mv "src/workspaceTypes.ts" "src/workspace/workspaceTypes.ts"
git mv "src/workspaceDirLogic.test.ts" "src/workspace/workspaceDirLogic.test.ts"
git mv "src/workspaceTypes.test.ts" "src/workspace/workspaceTypes.test.ts"
ls src/workspace | wc -l   # expect 11
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `workspace/` still import not-yet-moved modules as `./x`, which
now resolves inside `workspace/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/workspace
normalize_cross_domain
audit src/workspace
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/workspace/*'
rewrite CodeHighlight workspace/CodeHighlight
rewrite FileTree workspace/FileTree
rewrite FileViewer workspace/FileViewer
rewrite fileOpenBus workspace/fileOpenBus
rewrite useWorkspace workspace/useWorkspace
rewrite useWorkspaceFiles workspace/useWorkspaceFiles
rewrite workspaceApi workspace/workspaceApi
rewrite workspaceDirLogic workspace/workspaceDirLogic
rewrite workspaceTypes workspace/workspaceTypes
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group workspace modules"
```

---

### Task 9: `settings/`

Settings screens, the server-settings model and local preferences.

**Files:**
- Move: 7 source + 2 test files from `apps/desktop/src/` into `apps/desktop/src/settings/`
- Modify: every file importing them (rewritten to `@/settings/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/settings/<module>` for each of: `ServerSettingsScreen`, `SettingsScreen`, `preferences`, `serverConfig`, `serverSettingsActions`, `serverSettingsModel`, `useServerSettings`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/settings
git mv "src/ServerSettingsScreen.tsx" "src/settings/ServerSettingsScreen.tsx"
git mv "src/SettingsScreen.tsx" "src/settings/SettingsScreen.tsx"
git mv "src/preferences.ts" "src/settings/preferences.ts"
git mv "src/serverConfig.ts" "src/settings/serverConfig.ts"
git mv "src/serverSettingsActions.ts" "src/settings/serverSettingsActions.ts"
git mv "src/serverSettingsModel.ts" "src/settings/serverSettingsModel.ts"
git mv "src/useServerSettings.ts" "src/settings/useServerSettings.ts"
git mv "src/preferences.test.ts" "src/settings/preferences.test.ts"
git mv "src/serverSettingsModel.test.ts" "src/settings/serverSettingsModel.test.ts"
ls src/settings | wc -l   # expect 9
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `settings/` still import not-yet-moved modules as `./x`, which
now resolves inside `settings/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/settings
normalize_cross_domain
audit src/settings
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/settings/*'
rewrite ServerSettingsScreen settings/ServerSettingsScreen
rewrite SettingsScreen settings/SettingsScreen
rewrite preferences settings/preferences
rewrite serverConfig settings/serverConfig
rewrite serverSettingsActions settings/serverSettingsActions
rewrite serverSettingsModel settings/serverSettingsModel
rewrite useServerSettings settings/useServerSettings
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group settings modules"
```

---

### Task 10: `presentations/`

The HTML preview view and its hook. Two files.

**Files:**
- Move: 2 source + 0 test files from `apps/desktop/src/` into `apps/desktop/src/presentations/`
- Modify: every file importing them (rewritten to `@/presentations/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/presentations/<module>` for each of: `PresentationView`, `usePresentations`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/presentations
git mv "src/PresentationView.tsx" "src/presentations/PresentationView.tsx"
git mv "src/usePresentations.ts" "src/presentations/usePresentations.ts"
ls src/presentations | wc -l   # expect 2
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `presentations/` still import not-yet-moved modules as `./x`, which
now resolves inside `presentations/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/presentations
normalize_cross_domain
audit src/presentations
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/presentations/*'
rewrite PresentationView presentations/PresentationView
rewrite usePresentations presentations/usePresentations
```

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group presentations modules"
```

---

### Task 11: `shell/`

The top-level app hook and the chrome that hangs off it: overflow menus, alert modal, shell heat. Last because it imports the most from other domains.

**Files:**
- Move: 5 source + 0 test files from `apps/desktop/src/` into `apps/desktop/src/shell/`
- Modify: every file importing them (rewritten to `@/shell/…`)

**Interfaces:**
- Consumes: the `@/*` alias from Task 1.
- Produces: `@/shell/<module>` for each of: `AlertModal`, `AppOverflowMenu`, `OverflowMenu`, `useHeatArrival`, `useTetherDesktop`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
mkdir -p src/shell
git mv "src/AlertModal.tsx" "src/shell/AlertModal.tsx"
git mv "src/AppOverflowMenu.tsx" "src/shell/AppOverflowMenu.tsx"
git mv "src/OverflowMenu.tsx" "src/shell/OverflowMenu.tsx"
git mv "src/useHeatArrival.ts" "src/shell/useHeatArrival.ts"
git mv "src/useTetherDesktop.tsx" "src/shell/useTetherDesktop.tsx"
ls src/shell | wc -l   # expect 5
```

- [ ] **Step 2: Pass A2 — repoint imports that now dangle**

Files just moved into `shell/` still import not-yet-moved modules as `./x`, which
now resolves inside `shell/` and breaks. Rewrite those to `../x`; a later task's
Pass B turns them into aliases when those modules move.

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
fix_dangling src/shell
normalize_cross_domain
audit src/shell
```

Expected: the audit prints no dangling imports.

- [ ] **Step 3: Pass B — point every other file at the alias**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
. /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/desktop-reorg.sh
EXCL='-not -path src/shell/*'
rewrite AlertModal shell/AlertModal
rewrite AppOverflowMenu shell/AppOverflowMenu
rewrite OverflowMenu shell/OverflowMenu
rewrite useHeatArrival shell/useHeatArrival
rewrite useTetherDesktop shell/useTetherDesktop
```

- [ ] **Check: `useTetherDesktop.tsx` imports `./agent/newChat`, and at line ~443 does `await import('./desktopNotifications')` — a dynamic import the generalized helper covers, but verify it.**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
grep -n "agent/newChat\|await import(" src/shell/useTetherDesktop.tsx
```

Every hit must read `@/...` after Pass B. If one still reads `../` or `./`, fix it by hand.

- [ ] **Step 4: Format**

```bash
cd /home/samuelloranger/sites/tether && bun format
```

Rewriting specifiers reorders imports under Biome's `organizeImports` assist,
which is an **error**, not a warning. Skipping this reddens `bun lint`.

- [ ] **Step 5: Verify — build, lint, tests**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build     # tsc --noEmit && vite build
bun lint
bun run --cwd apps/desktop test
```

Expected: all three exit 0, and the suite reports **279 pass, 0 fail**.

Use the `build` script, never a bare `typecheck` — `tsc` resolves `@/` from
tsconfig and would pass even if vite could not resolve it.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group shell modules"
```

---

### Task 12: group the Rust noise modules

`src-tauri/src` has eight files at its root, four of which are one cluster:
`noise_session.rs`, `noise_store.rs`, `noise_token.rs`, `noise_ws.rs`. They become
`noise/{session,store,token,ws}.rs`.

`commands/` is left alone on purpose — it is the Tauri IPC boundary, a layer
rather than a domain. `commands/noise.rs` is 1217 lines and a fair split
candidate, but splitting it is a code change, not a move, and is out of scope.

**Files:**
- Move: `src-tauri/src/noise_{session,store,token,ws}.rs` → `src-tauri/src/noise/{session,store,token,ws}.rs`
- Create: `src-tauri/src/noise/mod.rs`
- Modify: `src-tauri/src/main.rs:6-9`, `src-tauri/src/state.rs:13`, `src-tauri/src/commands/noise.rs:17,22,26,29`

**Interfaces:**
- Consumes: nothing from the TypeScript tasks — this half is independent.
- Produces: `crate::noise::{session,store,token,ws}` in place of `crate::noise_*`.

- [ ] **Step 1: Move the four files and add the module root**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop/src-tauri/src
mkdir -p noise
git mv noise_session.rs noise/session.rs
git mv noise_store.rs   noise/store.rs
git mv noise_token.rs   noise/token.rs
git mv noise_ws.rs      noise/ws.rs
printf 'pub mod session;\npub mod store;\npub mod token;\npub mod ws;\n' > noise/mod.rs
```

- [ ] **Step 2: Replace the four module declarations with one**

In `src-tauri/src/main.rs`, lines 6-9:

```diff
 mod commands;
 mod http;
-mod noise_session;
-mod noise_store;
-mod noise_token;
-mod noise_ws;
+mod noise;
 mod state;
 mod storage;
```

- [ ] **Step 3: Repoint every `crate::noise_*` path**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop/src-tauri/src
grep -rl "crate::noise_" --include=*.rs . \
  | xargs sed -i -E 's/crate::noise_(session|store|token|ws)/crate::noise::\1/g'
grep -rn "crate::noise_" --include=*.rs . || echo "(clean)"
```

This touches `state.rs:13` (`crate::noise_token::CachedToken`) and
`commands/noise.rs:17,22,26,29` (all four modules). `noise/store.rs` also has
`use crate::storage::secret_error_message;` — a crate-root path, unaffected by
the move, and the regex does not match it.

- [ ] **Step 4: Verify**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop/src-tauri
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

Expected: exit 0. CI runs exactly this chain in the `desktop-build` job, so a
clippy warning is a hard failure, not an advisory.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop
git commit -m "refactor(desktop): group the noise modules in src-tauri

noise_session/store/token/ws were the only real cluster among the eight
files at the src-tauri root. commands/ stays as it is — it is the Tauri
IPC boundary, a layer rather than a domain."
```

---

### Task 13: workspace `CLAUDE.md`

The root `CLAUDE.md` now describes the server layout in detail and the desktop in
a single line. This gives the desktop its own map, loaded only when working here.

**Files:**
- Create: `apps/desktop/CLAUDE.md`

**Interfaces:**
- Consumes: the finished tree from Tasks 2-12.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the file**

Create `apps/desktop/CLAUDE.md` with exactly this content:

```markdown
# CLAUDE.md — apps/desktop

Tauri 2 desktop client (`tether-desktop`). Vite + React + xterm.js frontend;
Rust commands in `src-tauri/` link `tether-core` directly. Ships for Linux,
Windows and macOS, and talks to a POSIX-only server like any other client.

Keeps the legacy bundle identifier `cloud.samlo.tether` on purpose, so in-place
updates inherit the previous app's webview storage and host profiles.

## Commands

- `bun run --cwd apps/desktop build` — `tsc --noEmit && vite build`. **This is
  the gate**, not `typecheck`: see the alias note below.
- `bun run --cwd apps/desktop test` — 279 tests, `bun:test`, colocated.
- `bun run --cwd apps/desktop tauri:dev` / `tauri:build`
- `cd apps/desktop/src-tauri && cargo test` — CI also runs
  `cargo fmt --check && cargo clippy -- -D warnings`.

Put `run` **before** `--cwd`. `bun --cwd apps/desktop run test` prints the script
list and exits 0 without running anything (Bun 1.4.0).

## Layout

`src/` is four entry files plus one folder per domain, nothing deeper than one
level:

| | |
|---|---|
| `App.tsx` `main.tsx` `index.css` `vite-env.d.ts` | root; `main.tsx` imports `./index.css`, so they stay together |
| `terminal/` | xterm binding, clipboard, links, mouse, OSC, search, fit, frame handling, outbound gating, replay gate, paste |
| `session/` | drawer, tab bar, modals, icons, key/label/list/lru/resume/strip, residency, activity + lit state, tab drag |
| `pane/` | tiling tree and serialization, layout rects, drop zones, pane pickers, split preview |
| `host/` | host/device/pairing screens, address parsing, pairing code, noise host store and token, fingerprints |
| `platform/` | titlebar, window controls, deep links, notifications, updater, theme, native dialog |
| `workspace/` | file tree, viewer, highlighting, workspace API and types |
| `settings/` | settings screens, server-settings model, preferences |
| `agent/` `git/` | agent chat and the git drawer — the folders this layout was extended from |
| `shell/` | the top-level `useTetherDesktop` hook, overflow menus, alert modal |
| `core/` | Tauri invoke surface, transport, error decoding, shared types |
| `presentations/` | preview view and hook |

`src-tauri/src/` is `main.rs`, `state.rs`, `storage.rs`, `http.rs`, plus
`noise/` (session, store, token, ws) and `commands/` — the IPC boundary.

## Conventions & gotchas

- **Imports:** cross-domain uses `@/domain/module`; same-folder stays relative.
  Filenames keep their domain prefix (`terminal/terminalBind.ts`), so a component
  file still matches its export — `TerminalPane.tsx` exports `TerminalPane`.
- **The alias is wired twice, and only one half is honest.** `tsconfig.json` has
  `paths` (no `baseUrl` — TypeScript 7 removed it), and `vite.config.ts` reads
  that same file through `vite-tsconfig-paths`. Vite does **not** read tsconfig
  `paths` on its own, so without the plugin `tsc --noEmit` exits 0 while
  `vite build` fails on every `@/` import. Never gate on `typecheck` alone.
- **Do not add a `resolve.alias`.** It would duplicate the mapping in a second
  file that can drift. The plugin exists so there is one definition.
- Formatting is Biome, width 120, from the repo root — `bun format`. Rewriting
  imports reorders them under `organizeImports`, which is an error, not a warning.
- Tests are colocated (`foo.ts` + `foo.test.ts`) and run under bun, not vite —
  bun resolves tsconfig `paths` natively.
- **Native drag-drop swallows in-webview HTML5 DnD on Windows.** The Tauri
  drag-drop handler is kept for file upload, so in-app dragging must use pointer
  events instead.
- Sanitize the environment before spawning programs from the app: an AppImage
  inherits loader vars that break child processes.

## Out of scope, tracked separately

`App.tsx` is 741 lines with ~620 inside `App()` and 16 hooks; `commands/noise.rs`
is 1217. Both are split candidates and both are code changes rather than moves,
so each gets its own PR.
```

- [ ] **Step 2: Check every path it names actually exists**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
for d in terminal session pane host platform workspace settings agent git shell core presentations; do
  [ -d "src/$d" ] || echo "MISSING src/$d"
done
for f in src/App.tsx src/main.tsx src/index.css src/vite-env.d.ts \
         src-tauri/src/noise/mod.rs src-tauri/src/commands/mod.rs; do
  [ -f "$f" ] || echo "MISSING $f"
done
echo "(no MISSING lines above = every path in CLAUDE.md is real)"
```

- [ ] **Step 3: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/desktop/CLAUDE.md
git commit -m "docs(desktop): workspace CLAUDE.md

The root file describes the server in detail and the desktop in one
line. This carries the desktop's own map, and records the one thing
most likely to waste someone's afternoon: vite does not read tsconfig
paths, so a passing typecheck does not mean a working build."
```

---

### Task 14: full verification sweep

No code changes. The per-task gates cover types, bundling and unit tests; this
covers the real Tauri pipeline and proves nothing stale is left behind.

**Files:** none modified unless a check fails.

- [ ] **Step 1: Every import resolves**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
python3 /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/check-imports.py
```

Write that checker first:

```bash
cat > /tmp/claude-1000/-home-samuelloranger-sites-tether/5edeb6d5-ed1c-43ca-847a-bd0322fb6513/scratchpad/check-imports.py <<'CHECKER'
import pathlib, re
root = pathlib.Path('src')
pat = re.compile(r"(?:from |import\(|require\()'([^']+)'")
bad = []
for f in list(root.rglob('*.ts')) + list(root.rglob('*.tsx')):
    for spec in pat.findall(f.read_text()):
        if spec.startswith('@/'):
            t = root / spec[2:]
        elif spec.startswith('.'):
            t = (f.parent / spec).resolve()
        else:
            continue
        cands = (t, t.with_suffix('.ts'), t.with_suffix('.tsx'), t / 'index.ts', t / 'index.tsx')
        if not any(p.exists() for p in cands):
            bad.append("%s: '%s'" % (f, spec))
print("UNRESOLVED:", len(bad))
for b in bad:
    print("  ", b)
CHECKER
```

Expected: `UNRESOLVED: 0`. This is the check that caught six broken
`./proto/frame` imports in the server reorg.

- [ ] **Step 2: Nothing deeper than one level, and the root is only four files**

```bash
cd /home/samuelloranger/sites/tether/apps/desktop
ls src/*.ts src/*.tsx src/*.css 2>/dev/null | xargs -n1 basename
find src -mindepth 3 \( -name '*.ts' -o -name '*.tsx' \) || true
```

Expected: exactly `App.tsx`, `index.css`, `main.tsx`, `vite-env.d.ts`; and the
`find` prints nothing.

- [ ] **Step 3: No stale flat-path references anywhere in the repo**

```bash
cd /home/samuelloranger/sites/tether
grep -rnE "desktop/src/(terminalBind|sessionKey|paneTree|coreApi|preferences|viewModel|useTetherDesktop|workspaceApi|noiseHosts|titlebarChrome)" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=superpowers . \
  || echo "(clean)"
```

`--exclude-dir=superpowers` is deliberate: the plan and spec under
`docs/superpowers/` describe the move and must keep naming the old paths.

- [ ] **Step 4: Everything green**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/desktop build
bun run --cwd apps/desktop test
bun lint
cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

Expected: all green, 279 desktop tests passing.

- [ ] **Step 5: Prove the alias survives a real Tauri build**

`vite build` proves the bundler resolves `@/`; it does not prove the Tauri
wrapper does.

```bash
cd /home/samuelloranger/sites/tether
timeout 1800 bun run --cwd apps/desktop tauri:build 2>&1 | tail -20
```

Expected: a completed bundle. If the Tauri system dependencies are missing on
this host, say so plainly and leave it to CI's `desktop-build` job rather than
recording it as passed — that job builds on ubuntu, macOS and Windows.

- [ ] **Step 6: Review the diff for anything that is not a move**

```bash
cd /home/samuelloranger/sites/tether
git log --oneline refactor/server-domain-layout..HEAD
git diff --stat refactor/server-domain-layout...HEAD -- apps/desktop/src | tail -3
```

Every domain commit should show near-symmetric insertions and deletions — import
specifiers and Biome's reordering, nothing else. A commit with large asymmetric
content changes in `apps/desktop/src` means logic moved when it should not have.

- [ ] **Step 7: Push and open the PR**

```bash
cd /home/samuelloranger/sites/tether
git push -u origin refactor/desktop-domain-layout
```

Then open the PR with `gh pr create --base refactor/server-domain-layout`,
titled `refactor(desktop): domain-grouped module layout`, saying: it implements
`docs/superpowers/specs/2026-09-11-desktop-reorg-design.md`; it moves 96 flat
files into 10 domain folders alongside `agent/` and `git/`, groups the four
`noise_*.rs` modules, and adds a workspace `CLAUDE.md`; **no file is renamed**,
so the diff is paths plus import specifiers; it is **stacked on #183** and
targets that branch because #183 reformatted most of `apps/desktop` at 120
columns; the one thing reviewers should know is that vite does not read tsconfig
`paths`, so with the alias in tsconfig only, `tsc --noEmit` exits 0 while
`vite build` dies on `Rollup failed to resolve import "@/viewModel"` — hence
`vite-tsconfig-paths` and the `build`-script gate; and that splitting `App.tsx`,
splitting `commands/noise.rs` and the `crates/tether-core` test flake are each
their own PR.

---

## Follow-up, not part of this plan

- `App.tsx` — 741 lines, ~620 of them inside `App()` with 16 hooks. Its own PR.
- `src-tauri/src/commands/noise.rs` — 1217 lines. Its own PR.
- `crates/tether-core` `cargo test` flake — test binaries each spawn a server and
  collide on a port; a different test fails each run and `main` shows it too.
  Unrelated to this refactor, and CI runs it (`ci.yml:107`).
