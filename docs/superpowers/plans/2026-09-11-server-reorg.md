# Server Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat 170-entry `apps/server/src/server/` directory into 15 domain folders no more than 2 levels below `src/`, widen Biome to 120 columns, and restructure `CLAUDE.md`.

**Architecture:** Pure mechanical refactor — no behavior changes anywhere. Files move with `git mv`, imports are rewritten with scoped `sed` passes, and `tsc --noEmit` plus the existing 86-file test suite are the correctness oracle after every task. Cross-domain imports go through a new `@/*` tsconfig path alias; same-folder imports stay relative.

**Tech Stack:** Bun 1.4.x, TypeScript 7 (`moduleResolution: "bundler"`), Biome 2.5.9, `bun:test`, Hono.

**Spec:** `docs/superpowers/specs/2026-09-11-server-reorg-design.md`

## Global Constraints

- **Zero behavior change.** Every commit is a move, rename, reformat, or config edit. If a task requires editing logic to make tests pass, stop — something was moved wrong.
- **Bun ≥ 1.3.14** is the floor (`Bun.spawn(..., { terminal })`); dev and CI run 1.4.x.
- **Run tests as `bun run --cwd apps/server test`**, never bare `bun test` — the built-in runner shadows the script name and silently drops `--parallel` (12.8s → 3.3s).
- **Never set `TETHER_DB_PATH` for a suite run.** `apps/server/test-preload.ts` gives each worker its own temp DB; one shared file makes parallel workers fight.
- **No `process.platform === 'win32'` branches in `apps/server`.** Windows server support was removed in `8294d80d`.
- **This host runs the live tether daemon** (`~/.local/bin/tether serve`, its DB at `~/.tether/config/tether.db`, listening on 8085/8443). Never `pkill` by pattern — kill only a PID this plan recorded. Every probe server must set `TETHER_DB_PATH`, `TETHER_PORT=8199`, `TETHER_TLS=off` **and `TETHER_CONTROL_SOCK`**: `paths.ts` defaults the control socket to `~/.tether/control.sock`, which the live daemon holds, so a probe without that override races the daemon for its control plane.
- Biome formatting: 2-space indent, single quotes, semicolons, trailing commas. Width is 100 until Task 2, **120 from Task 2 onward**.
- Comments: minimal. Only a non-obvious "why" or a gotcha. Never restate the code.
- **No `Co-Authored-By` trailers** in commit messages.
- Every file path in this plan is relative to the repo root unless a command sets a `working-directory`.

## Known traps

These are the five places a naive `sed 's|from ...|...|'` pass will miss or corrupt. Every task that moves one of these files must handle it by hand.

| File | Line(s) | Form | Handling |
|---|---|---|---|
| `deviceCli.ts` | 81-83 | `require('./noiseFfi') as typeof import('./noiseFfi')` ×3 (also `./deviceRegistry`, `./deviceToken`) | Hand-edit. `require()` and `typeof import()` are not `from '…'`. |
| `gitOps.test.ts` | 285, 300 | `await import('./gitDiff')` ×2 | Hand-edit. |
| `dbStartup.test.ts` | 99, 148 | `new URL('./db.ts', import.meta.url)` ×2 | **Leave alone.** Runtime URL resolution — an alias does not resolve here. Both files land in `infra/`, so `./db.ts` stays correct. |
| `pty.ts` | 29-32 | `export … from './ptyHolder'` / `'./ptyResize'` / `'./ptyShell'` | Caught by the `from '…'` pattern. No special handling, but verify. |
| `noiseFfi.ts` | 10 | `import embeddedNoiseLib from './noiseNativeLib' with { type: 'file' }` | Caught by the `from '…'` pattern; the `with` clause is after the quote. Verify the asset path still resolves by running the build. |

Six test files also reach outside `src/` for shared helpers (`../../test-paths`, `../../test-shell`): `gitDiff.api.test.ts`, `gitRoot.test.ts`, `gitWatch.test.ts`, `pty.liveCwd.test.ts`, `pty.title.test.ts`, `workspaceFile.api.test.ts`. The helpers live at `apps/server/test-paths.ts` and `apps/server/test-shell.ts` and do **not** move. Their relative depth changes twice: `../../` → `../` in Task 3 (collapse), then `../` → `../../` when the file lands in a domain folder.

## The two rewrite passes

Every domain task uses the same two passes. Run them from `apps/server`.

**Pass A — intra-domain.** After `git mv`, files inside the new folder still import siblings by the *old* basename. Rewrite those to the new basename, keeping `./`.

**Pass B — external.** Every file outside the new folder imports the moved module by its old basename. Rewrite those to the `@/` alias.

Pass B needs two `sed` invocations because depth differs. Its shape is:

```bash
# rewrite <old-basename> <new-alias-path-without-leading-@/>
rewrite() {
  # still-flat modules at src/*.ts use './old'
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  # anything already in a subfolder (routes/, proto/, earlier domains) uses '../old'
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/<this-task-folder>/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
```

**Each task re-declares this helper with its own `-not -path` exclusions** — the
folder(s) that task just created must be skipped in the second `find`, or Pass B
would rewrite the sibling imports Pass A just fixed. Every task below spells the
helper out in full; copy it from the task you are on, not from here.

The trailing quote in the pattern anchors the match, so `'./log'` never matches `'./logTail'`, and `'./routes/config'` never matches the `'./config'` pattern.

---

### Task 1: Untrack the accidental runtime config dir

`apps/server/src/server/config/` is runtime output, not source. `ptyShell.ts:65-66` writes `zsh/.zshrc` and `zsh/.zshenv` at module load; the same module writes `tether.bashrc`; `paths.ts:22` puts the dev DB at `cwd()/config/tether.db`. Someone ran the server with cwd = `src/server`, and `.gitignore` only covered `apps/server/config/`, so six generated files were committed in `2b8ad1d5`.

`apps/server/src/web/` has zero tracked files and holds `node_modules/` and `dist/`.

**Files:**
- Delete (untrack): `apps/server/src/server/config/tether.db`, `tether.db-shm`, `tether.db-wal`, `tether.bashrc`, `zsh/.zshrc`, `zsh/.zshenv`
- Delete (untracked, on disk): `apps/server/src/web/`
- Modify: `.gitignore`
- Modify: `apps/server/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a `.gitignore` that covers `apps/server/**/config/`, so no later task can recommit a runtime dir regardless of which cwd the server was run from.

- [ ] **Step 1: Create the branch**

```bash
cd /home/samuelloranger/sites/tether
git checkout main && git pull --ff-only
git checkout -b refactor/server-domain-layout
```

- [ ] **Step 2: Confirm the six files are tracked and are generated**

```bash
git ls-files apps/server/src/server/config
grep -n "ZSH_RC_DIR\|writeFileSync" apps/server/src/server/ptyShell.ts | head
```

Expected: six paths listed; `ptyShell.ts` shows `writeFileSync(path.join(ZSH_RC_DIR, '.zshrc'), ZSHRC)` and `.zshenv`. If `git ls-files` lists anything *other* than those six, stop — an actual asset is in there and this plan's premise is wrong.

- [ ] **Step 3: Untrack them and delete the directory**

```bash
cd /home/samuelloranger/sites/tether
git rm -r --cached apps/server/src/server/config
rm -rf apps/server/src/server/config
rm -rf apps/server/src/web
```

- [ ] **Step 4: Widen the ignore patterns**

In `.gitignore`, replace line 8:

```
apps/server/src/web/dist/
```

with nothing (delete the line), and replace line 38:

```
apps/server/config/
```

with:

```
# Runtime config dir (db + generated shell rcfiles). Written relative to the
# server's cwd, so match it at any depth — a stray cwd once committed six
# generated files under src/server/config.
apps/server/**/config/
```

In `apps/server/.gitignore`, replace line 6:

```
src/web/dist/
```

with nothing (delete the line), and replace lines 9-10:

```
config/*.db
config/*.db-journal
```

with:

```
**/config/
```

- [ ] **Step 5: Verify the server still boots and regenerates its config**

```bash
cd /home/samuelloranger/sites/tether
rm -rf /tmp/tether-task1 && mkdir -p /tmp/tether-task1
TETHER_DB_PATH=/tmp/tether-task1/tether.db TETHER_PORT=8199 TETHER_TLS=off \
  TETHER_CONTROL_SOCK=/tmp/tether-task1/control.sock \
  timeout 15 bun apps/server/src/server/main.ts serve > /tmp/tether-task1/out.log 2>&1 &
sleep 6
curl -sf http://127.0.0.1:8199/api/status | head -c 200; echo
ls /tmp/tether-task1
```

Expected: `/api/status` returns JSON, and `/tmp/tether-task1` now contains `tether.bashrc` and a `zsh/` directory — proving the rc files are generated, not sourced from git.

- [ ] **Step 6: Confirm nothing new is staged accidentally**

```bash
git status --porcelain
```

Expected: only deletions under `apps/server/src/server/config/` and modifications to the two `.gitignore` files. If `apps/server/config/` or any other runtime dir appears, the ignore patterns are wrong — fix before committing.

- [ ] **Step 7: Run the suite**

```bash
bun run --cwd apps/server test
```

Expected: PASS. Nothing in the suite reads the committed config dir.

- [ ] **Step 8: Commit**

```bash
git add -A .gitignore apps/server/.gitignore apps/server/src
git commit -m "chore(server): untrack accidental runtime config dir

ptyShell.ts writes tether.bashrc and zsh/.zshrc + .zshenv at module
load, and paths.ts puts the dev DB at cwd()/config/tether.db. A run
with cwd = apps/server/src/server landed six generated files in git,
because .gitignore only covered apps/server/config.

Untrack all six, drop the untracked src/web directory (zero tracked
files, node_modules and dist only), and match the runtime config dir
at any depth so a stray cwd cannot recommit it."
```

---

### Task 2: Biome lineWidth 100 -> 120

Kept as its own commit so the reformat diff never mixes with a move diff.

**Files:**
- Modify: `biome.json`
- Modify: every `.ts` file Biome reformats (mechanical, produced by `bun format`)

**Interfaces:**
- Consumes: nothing.
- Produces: a 120-column baseline, so later tasks' formatting is stable and `bun format` is a no-op on moved files.

- [ ] **Step 1: Change the width**

In `biome.json`, in the `formatter` block:

```diff
     "indentWidth": 2,
-    "lineWidth": 100
+    "lineWidth": 120
```

Leave `noExcessiveLinesPerFile` at 400 and `noExcessiveLinesPerFunction` at 60. Do not touch them in this task.

- [ ] **Step 2: Record which files currently exceed the per-file limit**

```bash
cd /home/samuelloranger/sites/tether
find apps clients crates -name '*.ts' ! -name '*.test.ts' -not -path '*/node_modules/*' \
  -not -path '*/dist/*' -not -path '*proto/gen*' -print0 \
  | xargs -0 wc -l | sort -rn | awk '$1 > 400 && $2 != "total"' > /tmp/over400-before.txt
cat /tmp/over400-before.txt
```

Expected: `db.ts` (458) and `noiseSessionProtocol.ts` (437) at minimum. Keep this file — Step 5 compares against it.

- [ ] **Step 3: Reformat**

```bash
bun format
```

- [ ] **Step 4: Verify lint and types are clean**

```bash
bun lint
```

Expected: PASS. If `noExcessiveLinesPerFile` now errors on a file that previously passed, that is impossible from a width increase — investigate rather than suppressing.

- [ ] **Step 5: Re-measure and record the follow-up**

```bash
cd /home/samuelloranger/sites/tether
find apps clients crates -name '*.ts' ! -name '*.test.ts' -not -path '*/node_modules/*' \
  -not -path '*/dist/*' -not -path '*proto/gen*' -print0 \
  | xargs -0 wc -l | sort -rn | awk '$1 > 400 && $2 != "total"' > /tmp/over400-after.txt
diff /tmp/over400-before.txt /tmp/over400-after.txt || true
```

Note the files still over 400 in the PR description. Splitting them is explicitly out of scope for this plan — do not split anything here.

- [ ] **Step 6: Run the suite**

```bash
bun run --cwd apps/server test
bun run --cwd apps/desktop test
```

Expected: both PASS. Formatting cannot change behavior; a failure means `bun format` touched something it should not have.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "style: biome lineWidth 100 -> 120

Long generic signatures and chained Hono handlers wrap constantly at
100. Reformat only — noExcessiveLinesPerFile stays at 400 and
noExcessiveLinesPerFunction stays at 60, and the narrower lines the
reformat produces give both rules headroom without relaxing them."
```

---

### Task 3: Collapse `src/server/` into `src/`

`apps/server/src/` holds nothing else now that `src/web/` is gone, so the extra level is pure noise. This task changes paths only — no file is renamed and no import inside `src/` changes, because everything moves together.

**Files:**
- Move: all of `apps/server/src/server/*` → `apps/server/src/*`
- Modify: `apps/server/package.json` (`bin.tether`, `scripts.dev`, `scripts.build:binary`)
- Modify: `biome.json` (proto/gen exclusion)
- Modify: `.gitignore` (noiseNativeLib path)
- Modify: `.github/workflows/release.yml:582` (comment), `:614` (build entry)
- Modify: `.github/workflows/ci.yml:38` (comment)
- Modify: `scripts/build-ffi.ts:3` (comment), `:54` (FFI dest)
- Modify: `scripts/scratch-server.sh:5,113`
- Modify: `scripts/e2e/preseed-fixture.ts:8-10`
- Modify: `scripts/e2e/run-tab-switch.sh:31`, `run-preseed-connect.sh:34`, `run-agent-scrollback.sh:51`, `run-multihost.sh:27,30`, `run-lifecycle.sh:36`, `run-reconnect-replay.sh:31`, `run-server-restart.sh:27`, `run-reconnect-input.sh:30`, `run-bg-accumulation.sh:33`, `run-scrollback.sh:31`
- Modify: 6 test files whose `../../test-paths` / `../../test-shell` depth changes

**Interfaces:**
- Consumes: Task 1's ignore patterns.
- Produces: `apps/server/src/main.ts` as the binary entry, `apps/server/src/noise…`-free flat tree at `src/`, and `apps/server/src/noiseNativeLib` as the FFI staging path (renamed to `src/noise/nativeLib` in Task 8).

- [ ] **Step 1: Move everything up one level**

```bash
cd /home/samuelloranger/sites/tether/apps/server
git mv src/server/routes src/routes
git mv src/server/proto src/proto
for f in src/server/*.ts src/server/*.d.ts; do git mv "$f" "src/$(basename "$f")"; done
# the generated cdylib is gitignored, so git mv will not see it
[ -f src/server/noiseNativeLib ] && mv src/server/noiseNativeLib src/noiseNativeLib
rmdir src/server
ls src | head
```

Expected: `src/` now holds the flat `.ts` files plus `routes/` and `proto/`; `src/server` is gone.

- [ ] **Step 2: Fix the six test files that reach outside `src/`**

The shared helpers at `apps/server/test-paths.ts` and `apps/server/test-shell.ts` did not move, but the importers got one level shallower.

```bash
cd /home/samuelloranger/sites/tether/apps/server
sed -i "s|from '\.\./\.\./test-paths'|from '../test-paths'|g; s|from '\.\./\.\./test-shell'|from '../test-shell'|g" \
  src/gitDiff.api.test.ts src/gitRoot.test.ts src/gitWatch.test.ts \
  src/pty.liveCwd.test.ts src/pty.title.test.ts src/workspaceFile.api.test.ts
grep -rn "test-paths\|test-shell" src/*.ts
```

Expected: all six now read `from '../test-paths'` or `from '../test-shell'`.

- [ ] **Step 3: Update `apps/server/package.json`**

```diff
   "bin": {
-    "tether": "./src/server/main.ts"
+    "tether": "./src/main.ts"
   },
   "scripts": {
-    "dev": "bun run --watch src/server/index.ts",
+    "dev": "bun run --watch src/index.ts",
```

and in `build:binary`, change the trailing entry point:

```diff
-… --outfile dist/tether src/server/main.ts"
+… --outfile dist/tether src/main.ts"
```

- [ ] **Step 4: Update `biome.json` and `.gitignore`**

`biome.json`, in `files.includes`:

```diff
-      "!apps/server/src/server/proto/gen"
+      "!apps/server/src/proto/gen"
```

`.gitignore`, line 86:

```diff
 # Generated by scripts/build-ffi.ts: native cdylib embedded into the server binary
-apps/server/src/server/noiseNativeLib
+apps/server/src/noiseNativeLib
```

- [ ] **Step 5: Update the scripts and CI workflows**

```bash
cd /home/samuelloranger/sites/tether
grep -rl "apps/server/src/server" .github scripts \
  | xargs sed -i 's|apps/server/src/server|apps/server/src|g'
sed -i 's|src/server/main\.ts|src/main.ts|g' .github/workflows/release.yml
```

The first command covers `scripts/build-ffi.ts` (comment + `dest`), `scripts/scratch-server.sh`, all ten `scripts/e2e/run-*.sh`, `scripts/e2e/preseed-fixture.ts`, and the comments in both workflows. The second covers `release.yml:614`, where the path is relative to `working-directory: apps/server` and so is not prefixed.

- [ ] **Step 6: Verify no stale reference remains**

```bash
cd /home/samuelloranger/sites/tether
grep -rn "src/server" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=superpowers .
```

Expected: no output. `--exclude-dir=superpowers` is deliberate — `docs/superpowers/plans/` and `specs/` are historical records of past work and must keep their original paths. Do not rewrite them.

- [ ] **Step 7: Typecheck, build, test**

```bash
cd /home/samuelloranger/sites/tether
bun lint
bun run --cwd apps/server build
bun run --cwd apps/server test
```

Expected: all three PASS. The build proves the new `bin`/`build:binary` entry and the `{ type: 'file' }` cdylib import both resolve.

- [ ] **Step 8: Verify the compiled binary runs**

```bash
cd /home/samuelloranger/sites/tether
rm -rf /tmp/tether-task3 && mkdir -p /tmp/tether-task3
TETHER_DB_PATH=/tmp/tether-task3/tether.db TETHER_PORT=8199 TETHER_TLS=off \
  TETHER_CONTROL_SOCK=/tmp/tether-task3/control.sock \
  timeout 15 ./apps/server/dist/tether serve > /tmp/tether-task3/out.log 2>&1 &
sleep 6
curl -sf http://127.0.0.1:8199/api/status | head -c 200; echo
```

Expected: JSON response.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(server): collapse src/server into src

src/ held nothing else once the untracked src/web directory was
dropped, so the extra level was pure nesting. Paths only — no file is
renamed and no import inside src/ changes, since everything moves
together.

Updates the binary entry point, the FFI staging path, the biome
proto/gen exclusion, both workflows, scratch-server.sh and all ten
e2e runner scripts. The six test files that reach out to
test-paths/test-shell lose one ../ level."
```

---

### Task 4: `infra/` and `testing/`

Done first because these carry the highest fan-in — `db` (33 importers), `log` (12), `testAuth` (11), `config` (11), `paths` (8), `testEvents` (6), `runtime` (6). Moving them first exercises the alias across nearly the whole tree in one step.

`config.ts` becomes `infra/settings.ts`: it and `routes/config.ts` (the HTTP surface over it) currently read as near-twins, and after Task 12 they would sit at `infra/config.ts` and `http/config.ts`.

`testEvents.ts` goes to `infra/`, **not** `testing/` — `app.ts`, `pty.ts` and `noiseSessionProtocol.ts` import it, so it is production code. Only `testAuth.ts` is genuinely test-only.

**Files:**
- Move: `src/db.ts` → `src/infra/db.ts`; `src/log.ts` → `src/infra/log.ts`; `src/paths.ts` → `src/infra/paths.ts`; `src/runtime.ts` → `src/infra/runtime.ts`; `src/testEvents.ts` → `src/infra/testEvents.ts`; `src/config.ts` → `src/infra/settings.ts`
- Move: `src/db.test.ts`, `src/dbStartup.test.ts`, `src/testEvents.test.ts` → `src/infra/`; `src/config.test.ts` → `src/infra/settings.test.ts`
- Move: `src/testAuth.ts` → `src/testing/auth.ts`
- Modify: `apps/server/tsconfig.json` (add the alias)
- Modify: every file importing the above

**Interfaces:**
- Consumes: Task 3's flat `src/`.
- Produces the alias targets later tasks import: `@/infra/db`, `@/infra/log`, `@/infra/paths`, `@/infra/runtime`, `@/infra/settings`, `@/infra/testEvents`, `@/testing/auth`.

- [ ] **Step 1: Add the path alias**

In `apps/server/tsconfig.json`, inside `compilerOptions`:

```diff
     "skipLibCheck": true,
     "noEmit": true,
+    "baseUrl": ".",
+    "paths": { "@/*": ["./src/*"] },
     "types": ["bun-types"]
```

- [ ] **Step 2: Prove the alias resolves before moving anything**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p /tmp/alias-check && cat > /tmp/alias-check/probe.ts <<'EOF'
import { COMPILED } from '@/runtime';
console.log('alias resolves', COMPILED);
EOF
cp /tmp/alias-check/probe.ts src/__alias_probe.ts
bunx tsc --noEmit 2>&1 | head
bun build --compile --outfile /tmp/alias-check/probe src/__alias_probe.ts && /tmp/alias-check/probe
rm src/__alias_probe.ts
```

Expected: `tsc` reports no error for the probe, and the compiled binary prints `alias resolves false`. If either fails, stop — the alias config is wrong and every later task depends on it.

- [ ] **Step 3: Move the files**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/infra src/testing
for f in db log paths runtime testEvents; do git mv "src/$f.ts" "src/infra/$f.ts"; done
git mv src/config.ts src/infra/settings.ts
for f in db dbStartup testEvents; do git mv "src/$f.test.ts" "src/infra/$f.test.ts"; done
git mv src/config.test.ts src/infra/settings.test.ts
git mv src/testAuth.ts src/testing/auth.ts
```

- [ ] **Step 4: Pass A — intra-domain imports**

Inside `src/infra/`, siblings keep `./` but `config` became `settings`:

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/infra -name '*.ts' -print0 | xargs -0 -r sed -i "s|from '\./config'|from './settings'|g"
grep -rn "from '\./" src/infra/*.ts
```

Expected: only `./db`, `./log`, `./paths`, `./runtime`, `./settings`, `./testEvents` appear.

Leave `dbStartup.test.ts` lines 99 and 148 alone — `new URL('./db.ts', import.meta.url)` is runtime resolution, and `db.ts` is now its sibling, so it is already correct. Confirm:

```bash
grep -n "new URL" src/infra/dbStartup.test.ts
```

Expected: two hits, both still `'./db.ts'`.

- [ ] **Step 5: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/$3/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite db        infra/db        infra
rewrite log       infra/log       infra
rewrite paths     infra/paths     infra
rewrite runtime   infra/runtime   infra
rewrite testEvents infra/testEvents infra
rewrite config    infra/settings  infra
rewrite testAuth  testing/auth    testing
```

- [ ] **Step 6: Typecheck — the real oracle**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck
```

Expected: PASS. Any missed specifier — including the `require()` and `await import()` forms `sed` cannot see — surfaces here as an unresolved-module error. Fix each one by hand, then re-run.

- [ ] **Step 7: Lint and test**

```bash
bun lint
bun run --cwd apps/server test
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(server): move infra and test helpers into folders

db, log, paths, runtime and testEvents carry the highest fan-in in the
tree, so they move first and exercise the new @/* alias across nearly
every file in one step.

config.ts becomes infra/settings.ts: it and routes/config.ts (the HTTP
surface over it) read as near-twins today, and would sit side by side
as infra/config.ts and http/config.ts once the routes move.

testEvents stays production code — app.ts, pty.ts and
noiseSessionProtocol.ts import it — so it lands in infra/, not
testing/. Only testAuth is genuinely test-only."
```

---

### Task 5: `pty/`

The largest domain: PTY lifecycle, the detached holder, cwd tracking, and replay.

Three renames carry meaning. `pty.ts` owns the session registry, so it becomes `pty/registry.ts`. `holder.ts` is the detached process that owns a PTY and stays `pty/holder.ts`. `ptyHolder.ts` is the *server-side client* that talks to that process over the unix socket — the old name-pair invited confusing the two, so it becomes `pty/holderClient.ts`.

**Files:**
- Move (source): `pty.ts`→`pty/registry.ts`, `ptyHolder.ts`→`pty/holderClient.ts`, `holder.ts`→`pty/holder.ts`, `holderFrame.ts`→`pty/holderFrame.ts`, `ptyShell.ts`→`pty/shell.ts`, `ptyResize.ts`→`pty/resize.ts`, `spawnLimits.ts`→`pty/spawnLimits.ts`, `procCwd.ts`→`pty/procCwd.ts`, `procIdentity.ts`→`pty/procIdentity.ts`, `liveCwd.ts`→`pty/liveCwd.ts`, `cwdRefresh.ts`→`pty/cwdRefresh.ts`, `sessionActivity.ts`→`pty/activity.ts`, `sessionTitle.ts`→`pty/title.ts`, `signalSession.ts`→`pty/signal.ts`, `replayCursor.ts`→`pty/replayCursor.ts`, `replayPlan.ts`→`pty/replayPlan.ts`, `replayRead.ts`→`pty/replayRead.ts`
- Move (tests): `pty.env.test.ts`→`pty/registry.env.test.ts`, `pty.exitGuard.test.ts`→`pty/registry.exitGuard.test.ts`, `pty.kill.test.ts`→`pty/registry.kill.test.ts`, `pty.liveCwd.test.ts`→`pty/registry.liveCwd.test.ts`, `pty.shell.test.ts`→`pty/registry.shell.test.ts`, `pty.title.test.ts`→`pty/registry.title.test.ts`, `ptyHolder.negotiate.test.ts`→`pty/holderClient.negotiate.test.ts`, `ptyResize.test.ts`→`pty/resize.test.ts`, `holderFrame.test.ts`→`pty/holderFrame.test.ts`, `procCwd.test.ts`→`pty/procCwd.test.ts`, `procIdentity.test.ts`→`pty/procIdentity.test.ts`, `liveCwd.test.ts`→`pty/liveCwd.test.ts`, `cwdRefresh.test.ts`→`pty/cwdRefresh.test.ts`, `sessionActivity.test.ts`→`pty/activity.test.ts`, `sessionActivity.api.test.ts`→`pty/activity.api.test.ts`, `sessionTitle.test.ts`→`pty/title.test.ts`, `sessionTitle.api.test.ts`→`pty/title.api.test.ts`, `signal.api.test.ts`→`pty/signal.api.test.ts`, `replayCursor.test.ts`→`pty/replayCursor.test.ts`, `replayPlan.test.ts`→`pty/replayPlan.test.ts`

**Interfaces:**
- Consumes: `@/infra/db`, `@/infra/log`, `@/infra/paths`, `@/infra/runtime`, `@/infra/settings`, `@/infra/testEvents` from Task 4.
- Produces: `@/pty/registry`, `@/pty/holderClient`, `@/pty/holder`, `@/pty/holderFrame`, `@/pty/shell`, `@/pty/resize`, `@/pty/spawnLimits`, `@/pty/procCwd`, `@/pty/procIdentity`, `@/pty/liveCwd`, `@/pty/cwdRefresh`, `@/pty/activity`, `@/pty/title`, `@/pty/signal`, `@/pty/replayCursor`, `@/pty/replayPlan`, `@/pty/replayRead`. `@/pty/registry` re-exports `FocusSubscriber`, `SessionFrame`, `Subscriber`, `sockPathFor` (from `holderClient`), `clampDims` (from `resize`), and `getDefaultShell`, `ShellInvocation`, `shellInvocation` (from `shell`) — those re-export lines must survive the move.

- [ ] **Step 1: Move source files**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/pty
git mv src/pty.ts            src/pty/registry.ts
git mv src/ptyHolder.ts      src/pty/holderClient.ts
git mv src/holder.ts         src/pty/holder.ts
git mv src/holderFrame.ts    src/pty/holderFrame.ts
git mv src/ptyShell.ts       src/pty/shell.ts
git mv src/ptyResize.ts      src/pty/resize.ts
git mv src/spawnLimits.ts    src/pty/spawnLimits.ts
git mv src/procCwd.ts        src/pty/procCwd.ts
git mv src/procIdentity.ts   src/pty/procIdentity.ts
git mv src/liveCwd.ts        src/pty/liveCwd.ts
git mv src/cwdRefresh.ts     src/pty/cwdRefresh.ts
git mv src/sessionActivity.ts src/pty/activity.ts
git mv src/sessionTitle.ts   src/pty/title.ts
git mv src/signalSession.ts  src/pty/signal.ts
git mv src/replayCursor.ts   src/pty/replayCursor.ts
git mv src/replayPlan.ts     src/pty/replayPlan.ts
git mv src/replayRead.ts     src/pty/replayRead.ts
```

- [ ] **Step 2: Move test files**

```bash
cd /home/samuelloranger/sites/tether/apps/server
git mv src/pty.env.test.ts             src/pty/registry.env.test.ts
git mv src/pty.exitGuard.test.ts       src/pty/registry.exitGuard.test.ts
git mv src/pty.kill.test.ts            src/pty/registry.kill.test.ts
git mv src/pty.liveCwd.test.ts         src/pty/registry.liveCwd.test.ts
git mv src/pty.shell.test.ts           src/pty/registry.shell.test.ts
git mv src/pty.title.test.ts           src/pty/registry.title.test.ts
git mv src/ptyHolder.negotiate.test.ts src/pty/holderClient.negotiate.test.ts
git mv src/ptyResize.test.ts           src/pty/resize.test.ts
git mv src/holderFrame.test.ts         src/pty/holderFrame.test.ts
git mv src/procCwd.test.ts             src/pty/procCwd.test.ts
git mv src/procIdentity.test.ts        src/pty/procIdentity.test.ts
git mv src/liveCwd.test.ts             src/pty/liveCwd.test.ts
git mv src/cwdRefresh.test.ts          src/pty/cwdRefresh.test.ts
git mv src/sessionActivity.test.ts     src/pty/activity.test.ts
git mv src/sessionActivity.api.test.ts src/pty/activity.api.test.ts
git mv src/sessionTitle.test.ts        src/pty/title.test.ts
git mv src/sessionTitle.api.test.ts    src/pty/title.api.test.ts
git mv src/signal.api.test.ts          src/pty/signal.api.test.ts
git mv src/replayCursor.test.ts        src/pty/replayCursor.test.ts
git mv src/replayPlan.test.ts          src/pty/replayPlan.test.ts
```

- [ ] **Step 3: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/pty -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./pty'|from './registry'|g" \
  -e "s|from '\./ptyHolder'|from './holderClient'|g" \
  -e "s|from '\./ptyShell'|from './shell'|g" \
  -e "s|from '\./ptyResize'|from './resize'|g" \
  -e "s|from '\./sessionActivity'|from './activity'|g" \
  -e "s|from '\./sessionTitle'|from './title'|g" \
  -e "s|from '\./signalSession'|from './signal'|g"
```

- [ ] **Step 4: Fix the outside-`src/` test helper depth**

Two `pty` tests import `../test-paths` / `../test-shell` and are now one level deeper:

```bash
cd /home/samuelloranger/sites/tether/apps/server
sed -i "s|from '\.\./test-paths'|from '../../test-paths'|g; s|from '\.\./test-shell'|from '../../test-shell'|g" \
  src/pty/registry.liveCwd.test.ts src/pty/registry.title.test.ts
grep -rn "test-paths\|test-shell" src/pty/*.ts
```

Expected: both files now read `'../../test-paths'` / `'../../test-shell'`.

- [ ] **Step 5: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/pty/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite pty             pty/registry
rewrite ptyHolder       pty/holderClient
rewrite holder          pty/holder
rewrite holderFrame     pty/holderFrame
rewrite ptyShell        pty/shell
rewrite ptyResize       pty/resize
rewrite spawnLimits     pty/spawnLimits
rewrite procCwd         pty/procCwd
rewrite procIdentity    pty/procIdentity
rewrite liveCwd         pty/liveCwd
rewrite cwdRefresh      pty/cwdRefresh
rewrite sessionActivity pty/activity
rewrite sessionTitle    pty/title
rewrite signalSession   pty/signal
rewrite replayCursor    pty/replayCursor
rewrite replayPlan      pty/replayPlan
rewrite replayRead      pty/replayRead
```

- [ ] **Step 6: Verify the `pty/registry.ts` re-exports survived**

```bash
grep -n "^export .* from" src/pty/registry.ts
```

Expected four lines, pointing at `'./holderClient'`, `'./resize'`, `'./shell'`. If any still says `./ptyHolder` / `./ptyResize` / `./ptyShell`, Pass A missed it.

- [ ] **Step 7: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck
bun lint
bun run --cwd apps/server test
```

Expected: all PASS. Fix any unresolved specifier by hand and re-run.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(server): group pty modules

Session registry, the detached holder, cwd tracking and replay.

pty.ts owns the session registry, so it becomes pty/registry.ts.
holder.ts is the detached process that owns a PTY and keeps its name;
ptyHolder.ts is the server-side client that talks to it over the unix
socket, so it becomes pty/holderClient.ts — the old name-pair invited
confusing the two."
```

---

### Task 6: `agent/`

**Files:**
- Move (source): `agentDriver.ts`→`agent/driver.ts`, `agentClaudeDriver.ts`→`agent/claudeDriver.ts`, `agentEventMap.ts`→`agent/eventMap.ts`, `agentMessages.ts`→`agent/messages.ts`, `agentRegistry.ts`→`agent/registry.ts`, `agentReplay.ts`→`agent/replay.ts`, `agentUsage.ts`→`agent/usage.ts`, `claudeSessions.ts`→`agent/claudeSessions.ts`
- Move (tests): the matching `.test.ts` for each of the eight

**Interfaces:**
- Consumes: `@/infra/*`, `@/pty/registry`, `@/pty/activity` from Tasks 4-5.
- Produces: `@/agent/driver`, `@/agent/claudeDriver`, `@/agent/eventMap`, `@/agent/messages`, `@/agent/registry`, `@/agent/replay`, `@/agent/usage`, `@/agent/claudeSessions`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/agent
for pair in "agentDriver driver" "agentClaudeDriver claudeDriver" "agentEventMap eventMap" \
            "agentMessages messages" "agentRegistry registry" "agentReplay replay" \
            "agentUsage usage" "claudeSessions claudeSessions"; do
  set -- $pair
  git mv "src/$1.ts" "src/agent/$2.ts"
  [ -f "src/$1.test.ts" ] && git mv "src/$1.test.ts" "src/agent/$2.test.ts"
done
ls src/agent
```

Expected: 16 files (8 source + 8 test).

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/agent -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./agentDriver'|from './driver'|g" \
  -e "s|from '\./agentClaudeDriver'|from './claudeDriver'|g" \
  -e "s|from '\./agentEventMap'|from './eventMap'|g" \
  -e "s|from '\./agentMessages'|from './messages'|g" \
  -e "s|from '\./agentRegistry'|from './registry'|g" \
  -e "s|from '\./agentReplay'|from './replay'|g" \
  -e "s|from '\./agentUsage'|from './usage'|g"
```

- [ ] **Step 3: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/agent/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite agentDriver       agent/driver
rewrite agentClaudeDriver agent/claudeDriver
rewrite agentEventMap     agent/eventMap
rewrite agentMessages     agent/messages
rewrite agentRegistry     agent/registry
rewrite agentReplay       agent/replay
rewrite agentUsage        agent/usage
rewrite claudeSessions    agent/claudeSessions
```

- [ ] **Step 4: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(server): group agent modules

Agent drivers, registry, replay, usage accounting and the Claude
session index."
```

---

### Task 7: `auth/`

Device identity, bearer tokens, pairing and enrollment. Pairing *is* auth here, so it is one folder rather than three small ones.

`auth.ts` verifies per-device bearer tokens, so it becomes `auth/bearer.ts` — distinguishing it from `authGate.ts` (the Hono middleware), which becomes `auth/gate.ts`.

**Files:**
- Move (source): `auth.ts`→`auth/bearer.ts`, `authGate.ts`→`auth/gate.ts`, `deviceToken.ts`→`auth/deviceToken.ts`, `deviceRegistry.ts`→`auth/deviceRegistry.ts`, `deviceChannels.ts`→`auth/deviceChannels.ts`, `enrollment.ts`→`auth/enrollment.ts`, `pairControl.ts`→`auth/pairControl.ts`, `pairAdvertise.ts`→`auth/pairAdvertise.ts`, `pairQr.ts`→`auth/pairQr.ts`
- Move (tests): `auth.test.ts`→`auth/bearer.test.ts`, `authGate.test.ts`→`auth/gate.test.ts`, plus the matching test for each of the other seven
- Modify: `scripts/e2e/preseed-fixture.ts` (imports `deviceRegistry`)

**Interfaces:**
- Consumes: `@/infra/db`, `@/infra/log`, `@/infra/settings`, `@/testing/auth`.
- Produces: `@/auth/bearer`, `@/auth/gate`, `@/auth/deviceToken`, `@/auth/deviceRegistry`, `@/auth/deviceChannels`, `@/auth/enrollment`, `@/auth/pairControl`, `@/auth/pairAdvertise`, `@/auth/pairQr`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/auth
git mv src/auth.ts     src/auth/bearer.ts
git mv src/authGate.ts src/auth/gate.ts
git mv src/auth.test.ts     src/auth/bearer.test.ts
git mv src/authGate.test.ts src/auth/gate.test.ts
for f in deviceToken deviceRegistry deviceChannels enrollment pairControl pairAdvertise pairQr; do
  git mv "src/$f.ts" "src/auth/$f.ts"
  [ -f "src/$f.test.ts" ] && git mv "src/$f.test.ts" "src/auth/$f.test.ts"
done
ls src/auth
```

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/auth -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./auth'|from './bearer'|g" \
  -e "s|from '\./authGate'|from './gate'|g"
```

- [ ] **Step 3: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/auth/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite auth           auth/bearer
rewrite authGate       auth/gate
rewrite deviceToken    auth/deviceToken
rewrite deviceRegistry auth/deviceRegistry
rewrite deviceChannels auth/deviceChannels
rewrite enrollment     auth/enrollment
rewrite pairControl    auth/pairControl
rewrite pairAdvertise  auth/pairAdvertise
rewrite pairQr         auth/pairQr
```

- [ ] **Step 4: Hand-fix `deviceCli.ts`'s `require()` forms**

`deviceCli.ts` lines 81-83 use `require(...) as typeof import(...)`, which no `from '…'` pattern reaches. It is still at `src/deviceCli.ts` (it moves in Task 11). Edit those three lines:

```diff
-  const { genKeypair } = require('./noiseFfi') as typeof import('./noiseFfi');
-  const { addDevice } = require('./deviceRegistry') as typeof import('./deviceRegistry');
-  const { mintToken } = require('./deviceToken') as typeof import('./deviceToken');
+  const { genKeypair } = require('./noiseFfi') as typeof import('./noiseFfi');
+  const { addDevice } = require('@/auth/deviceRegistry') as typeof import('@/auth/deviceRegistry');
+  const { mintToken } = require('@/auth/deviceToken') as typeof import('@/auth/deviceToken');
```

`./noiseFfi` is left untouched here — it moves in Task 8.

- [ ] **Step 5: Update the e2e fixture**

`scripts/e2e/preseed-fixture.ts` lives outside `apps/server` and is not covered by that tsconfig, so it keeps relative imports:

```diff
-import { upsertDevice } from '../../apps/server/src/deviceRegistry';
+import { upsertDevice } from '../../apps/server/src/auth/deviceRegistry';
```

- [ ] **Step 6: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(server): group auth, device and pairing modules

Pairing is auth here, so device identity, bearer tokens, enrollment and
the three pair modules share one folder rather than splitting into
three small ones.

auth.ts verifies per-device bearer tokens (auth/bearer.ts); authGate.ts
is the Hono middleware (auth/gate.ts)."
```

---

### Task 8: `noise/` and `tls/`

Kept as two sibling folders rather than one `transport/`. A single folder would force every file to keep its `noise`/`tls` prefix to stay distinguishable, defeating the point.

`noiseNativeLib` is the generated cdylib (`scripts/build-ffi.ts` stages it there, `.gitignore` excludes it, and `noiseFfi.ts:10` imports it as a `{ type: 'file' }` asset). It moves too, which means the build script, the ignore rule and both workflow comments change.

**Files:**
- Move (source): `noiseChannel.ts`→`noise/channel.ts`, `noiseFfi.ts`→`noise/ffi.ts`, `noiseIdentity.ts`→`noise/identity.ts`, `noiseSessionProtocol.ts`→`noise/sessionProtocol.ts`, `noiseWsAdapter.ts`→`noise/wsAdapter.ts`, `noiseNativeLib.d.ts`→`noise/nativeLib.d.ts`, `tlsConfig.ts`→`tls/config.ts`, `tlsRuntime.ts`→`tls/runtime.ts`, `tlsStore.ts`→`tls/store.ts`, `x509.ts`→`tls/x509.ts`
- Move (generated, untracked): `src/noiseNativeLib` → `src/noise/nativeLib`
- Move (tests): matching tests for all ten, plus `tls.api.test.ts`→`tls/api.test.ts`
- Modify: `scripts/build-ffi.ts:3,54`, `.gitignore:86`, `.github/workflows/release.yml` comment, `.github/workflows/ci.yml` comment, `src/deviceCli.ts:81`, `src/tls/store.ts` comment

**Interfaces:**
- Consumes: `@/infra/db`, `@/infra/log`, `@/infra/paths`, `@/infra/settings`, `@/auth/deviceRegistry`, `@/pty/registry`.
- Produces: `@/noise/channel`, `@/noise/ffi`, `@/noise/identity`, `@/noise/sessionProtocol`, `@/noise/wsAdapter`, `@/tls/config`, `@/tls/runtime`, `@/tls/store`, `@/tls/x509`.

- [ ] **Step 1: Move source, tests and the generated cdylib**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/noise src/tls
for pair in "noiseChannel channel" "noiseFfi ffi" "noiseIdentity identity" \
            "noiseSessionProtocol sessionProtocol" "noiseWsAdapter wsAdapter"; do
  set -- $pair
  git mv "src/$1.ts" "src/noise/$2.ts"
  [ -f "src/$1.test.ts" ] && git mv "src/$1.test.ts" "src/noise/$2.test.ts"
done
git mv src/noiseNativeLib.d.ts src/noise/nativeLib.d.ts
[ -f src/noiseNativeLib ] && mv src/noiseNativeLib src/noise/nativeLib

for pair in "tlsConfig config" "tlsRuntime runtime" "tlsStore store" "x509 x509"; do
  set -- $pair
  git mv "src/$1.ts" "src/tls/$2.ts"
  [ -f "src/$1.test.ts" ] && git mv "src/$1.test.ts" "src/tls/$2.test.ts"
done
git mv src/tls.api.test.ts src/tls/api.test.ts
```

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/noise -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./noiseChannel'|from './channel'|g" \
  -e "s|from '\./noiseFfi'|from './ffi'|g" \
  -e "s|from '\./noiseIdentity'|from './identity'|g" \
  -e "s|from '\./noiseSessionProtocol'|from './sessionProtocol'|g" \
  -e "s|from '\./noiseWsAdapter'|from './wsAdapter'|g" \
  -e "s|from '\./noiseNativeLib'|from './nativeLib'|g"
find src/tls -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./tlsConfig'|from './config'|g" \
  -e "s|from '\./tlsRuntime'|from './runtime'|g" \
  -e "s|from '\./tlsStore'|from './store'|g"
```

- [ ] **Step 3: Verify the cdylib asset import**

```bash
grep -n "nativeLib" src/noise/ffi.ts
```

Expected: `import embeddedNoiseLib from './nativeLib' with { type: 'file' };`. The `with` clause sits after the closing quote, so the pattern reached it. If it still says `./noiseNativeLib`, fix by hand.

- [ ] **Step 4: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' \
    -not -path "src/noise/*" -not -path "src/tls/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite noiseChannel         noise/channel
rewrite noiseFfi             noise/ffi
rewrite noiseIdentity        noise/identity
rewrite noiseSessionProtocol noise/sessionProtocol
rewrite noiseWsAdapter       noise/wsAdapter
rewrite tlsConfig            tls/config
rewrite tlsRuntime           tls/runtime
rewrite tlsStore             tls/store
rewrite x509                 tls/x509
```

- [ ] **Step 5: Hand-fix `deviceCli.ts`'s remaining `require()`**

```diff
-  const { genKeypair } = require('./noiseFfi') as typeof import('./noiseFfi');
+  const { genKeypair } = require('@/noise/ffi') as typeof import('@/noise/ffi');
```

- [ ] **Step 6: Update the FFI staging path everywhere**

`scripts/build-ffi.ts` line 54:

```diff
-const dest = join(root, 'apps/server/src/noiseNativeLib');
+const dest = join(root, 'apps/server/src/noise/nativeLib');
```

and its line 3 comment, `(`apps/server/src/noiseNativeLib`)` → `(`apps/server/src/noise/nativeLib`)`.

`.gitignore` line 86:

```diff
-apps/server/src/noiseNativeLib
+apps/server/src/noise/nativeLib
```

`.github/workflows/release.yml` — the comment above the FFI build step, `apps/server/src/noiseNativeLib` → `apps/server/src/noise/nativeLib`.

`.github/workflows/ci.yml` — the comment, `apps/server/src/noiseFfi.ts` → `apps/server/src/noise/ffi.ts`.

`src/tls/store.ts` — the comment mentioning `config/tether.db` stays accurate; no change.

- [ ] **Step 7: Rebuild the cdylib from scratch to prove the new dest**

```bash
cd /home/samuelloranger/sites/tether
rm -f apps/server/src/noise/nativeLib
bun run --cwd apps/server build:ffi
ls -l apps/server/src/noise/nativeLib
```

Expected: `build-ffi:` log line ending in `apps/server/src/noise/nativeLib`, and the file exists.

- [ ] **Step 8: Update `scripts/e2e/preseed-fixture.ts`**

```diff
-import { genKeypair } from '../../apps/server/src/noiseFfi';
-import { loadOrCreateServerKeypair } from '../../apps/server/src/noiseIdentity';
+import { genKeypair } from '../../apps/server/src/noise/ffi';
+import { loadOrCreateServerKeypair } from '../../apps/server/src/noise/identity';
```

- [ ] **Step 9: Typecheck, lint, test, build**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint
bun run --cwd apps/server test
bun run --cwd apps/server build
```

Expected: all PASS. The build is mandatory here — it is the only check that proves the `{ type: 'file' }` cdylib embed still resolves. Confirm `git status --porcelain` does not list `apps/server/src/noise/nativeLib` (the ignore rule must be working).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(server): split noise and tls into sibling folders

Two folders rather than one transport/: a single folder would force
every file to keep its noise/tls prefix to stay distinguishable,
defeating the prefix drop.

The generated cdylib moves with them (src/noise/nativeLib), so
build-ffi.ts's dest, the ignore rule and both workflow comments move
too."
```

---

### Task 9: `git/` and `workspace/`

**Files:**
- Move (source): `gitDiff.ts`→`git/diff.ts`, `gitOps.ts`→`git/ops.ts`, `gitRoot.ts`→`git/root.ts`, `gitStatus.ts`→`git/status.ts`, `gitWatch.ts`→`git/watch.ts`, `gitWatchIgnore.ts`→`git/watchIgnore.ts`, `gitWatchIgnoredDirs.ts`→`git/watchIgnoredDirs.ts`, `workspaceFile.ts`→`workspace/file.ts`, `workspacePath.ts`→`workspace/path.ts`, `workspaceDir.ts`→`workspace/dir.ts`, `upload.ts`→`workspace/upload.ts`
- Move (tests): `gitDiff.test.ts`→`git/diff.test.ts`, `gitDiff.api.test.ts`→`git/diff.api.test.ts`, `gitOps.test.ts`→`git/ops.test.ts`, `gitOps.api.test.ts`→`git/ops.api.test.ts`, `gitRoot.test.ts`→`git/root.test.ts`, `gitStatus.test.ts`→`git/status.test.ts`, `gitWatch.test.ts`→`git/watch.test.ts`, `gitWatchIgnore.test.ts`→`git/watchIgnore.test.ts`, `workspaceFile.test.ts`→`workspace/file.test.ts`, `workspaceFile.api.test.ts`→`workspace/file.api.test.ts`, `workspaceDir.test.ts`→`workspace/dir.test.ts`, `upload.test.ts`→`workspace/upload.test.ts`

**Interfaces:**
- Consumes: `@/infra/*`, `@/pty/registry`, `@/pty/liveCwd`.
- Produces: `@/git/diff`, `@/git/ops`, `@/git/root`, `@/git/status`, `@/git/watch`, `@/git/watchIgnore`, `@/git/watchIgnoredDirs`, `@/workspace/file`, `@/workspace/path`, `@/workspace/dir`, `@/workspace/upload`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/git src/workspace
for pair in "gitDiff diff" "gitOps ops" "gitRoot root" "gitStatus status" \
            "gitWatch watch" "gitWatchIgnore watchIgnore" "gitWatchIgnoredDirs watchIgnoredDirs"; do
  set -- $pair
  git mv "src/$1.ts" "src/git/$2.ts"
  [ -f "src/$1.test.ts" ]     && git mv "src/$1.test.ts"     "src/git/$2.test.ts"
  [ -f "src/$1.api.test.ts" ] && git mv "src/$1.api.test.ts" "src/git/$2.api.test.ts"
done
for pair in "workspaceFile file" "workspacePath path" "workspaceDir dir" "upload upload"; do
  set -- $pair
  git mv "src/$1.ts" "src/workspace/$2.ts"
  [ -f "src/$1.test.ts" ]     && git mv "src/$1.test.ts"     "src/workspace/$2.test.ts"
  [ -f "src/$1.api.test.ts" ] && git mv "src/$1.api.test.ts" "src/workspace/$2.api.test.ts"
done
```

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/git -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./gitDiff'|from './diff'|g" \
  -e "s|from '\./gitOps'|from './ops'|g" \
  -e "s|from '\./gitRoot'|from './root'|g" \
  -e "s|from '\./gitStatus'|from './status'|g" \
  -e "s|from '\./gitWatch'|from './watch'|g" \
  -e "s|from '\./gitWatchIgnore'|from './watchIgnore'|g" \
  -e "s|from '\./gitWatchIgnoredDirs'|from './watchIgnoredDirs'|g"
find src/workspace -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./workspaceFile'|from './file'|g" \
  -e "s|from '\./workspacePath'|from './path'|g" \
  -e "s|from '\./workspaceDir'|from './dir'|g"
```

Note the ordering hazard: `gitWatchIgnore` is a prefix of `gitWatchIgnoredDirs`, but the trailing `'` in each pattern anchors the match, so `'./gitWatchIgnore'` never matches `'./gitWatchIgnoredDirs'`. Same for `gitWatch` vs both.

- [ ] **Step 3: Hand-fix `gitOps.test.ts`'s dynamic imports**

`src/git/ops.test.ts` lines 285 and 300 use `await import('./gitDiff')`, which no `from '…'` pattern reaches:

```diff
-    const { readDiff } = await import('./gitDiff');
+    const { readDiff } = await import('./diff');
```

Both occurrences. Verify:

```bash
grep -n "await import(" src/git/ops.test.ts
```

Expected: two hits, both `'./diff'`.

- [ ] **Step 4: Fix the outside-`src/` test helper depth**

Four tests in these two folders reach for the shared helpers:

```bash
cd /home/samuelloranger/sites/tether/apps/server
sed -i "s|from '\.\./test-paths'|from '../../test-paths'|g; s|from '\.\./test-shell'|from '../../test-shell'|g" \
  src/git/diff.api.test.ts src/git/root.test.ts src/git/watch.test.ts src/workspace/file.api.test.ts
grep -rn "test-paths\|test-shell" src/git/*.ts src/workspace/*.ts
```

Expected: all four now read `'../../test-paths'` or `'../../test-shell'`.

- [ ] **Step 5: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' \
    -not -path "src/git/*" -not -path "src/workspace/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite gitDiff             git/diff
rewrite gitOps              git/ops
rewrite gitRoot             git/root
rewrite gitStatus           git/status
rewrite gitWatch            git/watch
rewrite gitWatchIgnore      git/watchIgnore
rewrite gitWatchIgnoredDirs git/watchIgnoredDirs
rewrite workspaceFile       workspace/file
rewrite workspacePath       workspace/path
rewrite workspaceDir        workspace/dir
rewrite upload              workspace/upload
```

- [ ] **Step 6: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(server): group git and workspace modules

git diff/ops/status/root plus the three watch modules, and the
workspace file/path/dir trio with upload."
```

---

### Task 10: `push/` and `presentations/`

The two presentation modules are named backwards today: `presentations.ts` defines the `PresentationRegistry` class, `resolvePresentationFile` and the `Presentation` type, while `presentationRegistry.ts` holds nothing but `export const presentations = new PresentationRegistry()`. The move puts the class in `registry.ts` and the singleton in `instance.ts`.

**Files:**
- Move (source): `push.ts`→`push/send.ts`, `pushCrypto.ts`→`push/crypto.ts`, `pushDevices.ts`→`push/devices.ts`, `pushRelay.ts`→`push/relay.ts`, `notifications.ts`→`push/notifications.ts`, `presentations.ts`→`presentations/registry.ts`, `presentationRegistry.ts`→`presentations/instance.ts`, `presentCli.ts`→`presentations/cli.ts`
- Move (tests): `push.test.ts`→`push/send.test.ts`, `pushCrypto.test.ts`→`push/crypto.test.ts`, `pushDevices.test.ts`→`push/devices.test.ts`, `notifications.test.ts`→`push/notifications.test.ts`, `presentations.test.ts`→`presentations/registry.test.ts`, `presentCli.test.ts`→`presentations/cli.test.ts`

**Interfaces:**
- Consumes: `@/infra/*`, `@/auth/deviceRegistry`, `@/pty/activity`, `@/pty/registry`.
- Produces: `@/push/send`, `@/push/crypto`, `@/push/devices`, `@/push/relay`, `@/push/notifications`, `@/presentations/registry`, `@/presentations/instance`, `@/presentations/cli`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/push src/presentations
for pair in "push send" "pushCrypto crypto" "pushDevices devices" \
            "pushRelay relay" "notifications notifications"; do
  set -- $pair
  git mv "src/$1.ts" "src/push/$2.ts"
  [ -f "src/$1.test.ts" ] && git mv "src/$1.test.ts" "src/push/$2.test.ts"
done
git mv src/presentations.ts         src/presentations/registry.ts
git mv src/presentationRegistry.ts  src/presentations/instance.ts
git mv src/presentCli.ts            src/presentations/cli.ts
git mv src/presentations.test.ts    src/presentations/registry.test.ts
git mv src/presentCli.test.ts       src/presentations/cli.test.ts
```

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/push -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./push'|from './send'|g" \
  -e "s|from '\./pushCrypto'|from './crypto'|g" \
  -e "s|from '\./pushDevices'|from './devices'|g" \
  -e "s|from '\./pushRelay'|from './relay'|g"
find src/presentations -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./presentations'|from './registry'|g" \
  -e "s|from '\./presentationRegistry'|from './instance'|g" \
  -e "s|from '\./presentCli'|from './cli'|g"
```

- [ ] **Step 3: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' \
    -not -path "src/push/*" -not -path "src/presentations/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite push                 push/send
rewrite pushCrypto           push/crypto
rewrite pushDevices          push/devices
rewrite pushRelay            push/relay
rewrite notifications        push/notifications
rewrite presentations        presentations/registry
rewrite presentationRegistry presentations/instance
rewrite presentCli           presentations/cli
```

- [ ] **Step 4: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(server): group push and presentation modules

The two presentation modules were named backwards: presentations.ts
defines the PresentationRegistry class, presentationRegistry.ts holds
only the shared singleton. The class now lives in registry.ts and the
singleton in instance.ts."
```

---

### Task 11: `cli/` and `control/`

`cli/` is the subcommands the binary dispatches from `main.ts`. `control/` is the loopback control socket surface those subcommands talk to — server-side, but it exists only to serve the CLI.

**Files:**
- Move (source): `deviceCli.ts`→`cli/device.ts`, `pairCli.ts`→`cli/pair.ts`, `signalCli.ts`→`cli/signal.ts`, `logTail.ts`→`cli/logTail.ts`, `update.ts`→`cli/update.ts`, `controlApp.ts`→`control/app.ts`, `controlServe.ts`→`control/serve.ts`, `controlSocket.ts`→`control/socket.ts`
- Move (tests): `deviceCli.test.ts`→`cli/device.test.ts`, `pairCli.test.ts`→`cli/pair.test.ts`, `signalCli.test.ts`→`cli/signal.test.ts`, `logTail.test.ts`→`cli/logTail.test.ts`, `update.test.ts`→`cli/update.test.ts`, `update.digest.test.ts`→`cli/update.digest.test.ts`, `update.swap.test.ts`→`cli/update.swap.test.ts`, `controlApp.test.ts`→`control/app.test.ts`, `controlServe.test.ts`→`control/serve.test.ts`, `controlSocket.test.ts`→`control/socket.test.ts`

**Interfaces:**
- Consumes: `@/infra/*`, `@/auth/*`, `@/noise/ffi`, `@/presentations/instance`, `@/pty/signal`.
- Produces: `@/cli/device`, `@/cli/pair`, `@/cli/signal`, `@/cli/logTail`, `@/cli/update`, `@/control/app`, `@/control/serve`, `@/control/socket`.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/cli src/control
git mv src/deviceCli.ts src/cli/device.ts
git mv src/pairCli.ts   src/cli/pair.ts
git mv src/signalCli.ts src/cli/signal.ts
git mv src/logTail.ts   src/cli/logTail.ts
git mv src/update.ts    src/cli/update.ts
git mv src/deviceCli.test.ts src/cli/device.test.ts
git mv src/pairCli.test.ts   src/cli/pair.test.ts
git mv src/signalCli.test.ts src/cli/signal.test.ts
git mv src/logTail.test.ts   src/cli/logTail.test.ts
git mv src/update.test.ts        src/cli/update.test.ts
git mv src/update.digest.test.ts src/cli/update.digest.test.ts
git mv src/update.swap.test.ts   src/cli/update.swap.test.ts
git mv src/controlApp.ts    src/control/app.ts
git mv src/controlServe.ts  src/control/serve.ts
git mv src/controlSocket.ts src/control/socket.ts
git mv src/controlApp.test.ts    src/control/app.test.ts
git mv src/controlServe.test.ts  src/control/serve.test.ts
git mv src/controlSocket.test.ts src/control/socket.test.ts
```

- [ ] **Step 2: Pass A — intra-domain imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/cli -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./deviceCli'|from './device'|g" \
  -e "s|from '\./pairCli'|from './pair'|g" \
  -e "s|from '\./signalCli'|from './signal'|g"
find src/control -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\./controlApp'|from './app'|g" \
  -e "s|from '\./controlServe'|from './serve'|g" \
  -e "s|from '\./controlSocket'|from './socket'|g"
```

- [ ] **Step 3: Pass B — external imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' \
    -not -path "src/cli/*" -not -path "src/control/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite deviceCli     cli/device
rewrite pairCli       cli/pair
rewrite signalCli     cli/signal
rewrite logTail       cli/logTail
rewrite update        cli/update
rewrite controlApp    control/app
rewrite controlServe  control/serve
rewrite controlSocket control/socket
```

- [ ] **Step 4: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS. `src/cli/device.ts` still holds the three `require()` forms fixed in Tasks 7 and 8 — confirm they read `@/auth/deviceRegistry`, `@/auth/deviceToken`, `@/noise/ffi`:

```bash
grep -n "require(" apps/server/src/cli/device.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(server): group cli subcommands and the control surface

cli/ is what main.ts dispatches; control/ is the loopback socket
surface those subcommands talk to — server-side, but it exists only to
serve the CLI."
```

---

### Task 12: `http/`

The last domain. `routes/` is flattened into `http/` rather than kept as `http/routes/` — the extra level buys nothing when `http/` holds only the Hono app and its route modules.

After this task `src/` contains exactly three loose files: `main.ts`, `index.ts`, `serve.ts`.

**Files:**
- Move (source): `app.ts`→`http/app.ts`, `admin.ts`→`http/admin.ts`, `routes/config.ts`→`http/config.ts`, `routes/files.ts`→`http/files.ts`, `routes/fs.ts`→`http/fs.ts`, `routes/git.ts`→`http/git.ts`, `routes/noise.ts`→`http/noise.ts`, `routes/presentations.ts`→`http/presentations.ts`, `routes/previewMime.ts`→`http/previewMime.ts`, `routes/sessionCwd.ts`→`http/sessionCwd.ts`, `routes/sessions.ts`→`http/sessions.ts`, `routes/terminalCodec.ts`→`http/terminalCodec.ts`
- Move (tests): `app.rateLimit.test.ts`→`http/app.rateLimit.test.ts`, `admin.api.test.ts`→`http/admin.api.test.ts`, `config.api.test.ts`→`http/config.api.test.ts`, `presentations.api.test.ts`→`http/presentations.api.test.ts`, `gitDiff.api.test.ts` and `gitOps.api.test.ts` already live in `git/` — leave them, `routes/fs.test.ts`→`http/fs.test.ts`, `routes/sessions.test.ts`→`http/sessions.test.ts`, `routes/terminalCodec.test.ts`→`http/terminalCodec.test.ts`

**Interfaces:**
- Consumes: every `@/` alias produced by Tasks 4-11.
- Produces: `@/http/app` (imported by `src/serve.ts` and `src/index.ts`), plus `@/http/*` for each route module.

- [ ] **Step 1: Move source and tests**

```bash
cd /home/samuelloranger/sites/tether/apps/server
mkdir -p src/http
git mv src/app.ts   src/http/app.ts
git mv src/admin.ts src/http/admin.ts
git mv src/app.rateLimit.test.ts    src/http/app.rateLimit.test.ts
git mv src/admin.api.test.ts        src/http/admin.api.test.ts
git mv src/config.api.test.ts       src/http/config.api.test.ts
git mv src/presentations.api.test.ts src/http/presentations.api.test.ts
for f in config files fs git noise presentations previewMime sessionCwd sessions terminalCodec; do
  git mv "src/routes/$f.ts" "src/http/$f.ts"
  [ -f "src/routes/$f.test.ts" ] && git mv "src/routes/$f.test.ts" "src/http/$f.test.ts"
done
rmdir src/routes
ls src
```

Expected: `src` lists `main.ts`, `index.ts`, `serve.ts` and the 15 domain folders. Nothing else.

- [ ] **Step 2: Pass A — intra-domain imports**

Route modules previously reached siblings as `'./fs'`, `'./previewMime'` etc., and reached `app.ts` as `'../app'`. Both forms now resolve within `http/`:

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src/http -name '*.ts' -print0 | xargs -0 -r sed -i \
  -e "s|from '\.\./app'|from './app'|g" \
  -e "s|from '\.\./admin'|from './admin'|g"
for f in config files fs git noise presentations previewMime sessionCwd sessions terminalCodec; do
  find src/http -name '*.ts' -print0 | xargs -0 -r sed -i "s|from '\./routes/$f'|from './$f'|g"
done
```

- [ ] **Step 3: Pass B — external imports**

The three loose files at `src/` and any domain file importing `./app`, `./admin` or `./routes/*`:

```bash
cd /home/samuelloranger/sites/tether/apps/server
rewrite() {
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./$1'|from '@/$2'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/http/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./$1'|from '@/$2'|g"
}
rewrite app   http/app
rewrite admin http/admin
for f in config files fs git noise presentations previewMime sessionCwd sessions terminalCodec; do
  find src -maxdepth 1 -name '*.ts' -print0 \
    | xargs -0 -r sed -i "s|from '\./routes/$f'|from '@/http/$f'|g"
  find src -mindepth 2 -maxdepth 2 -name '*.ts' -not -path "src/http/*" -print0 \
    | xargs -0 -r sed -i "s|from '\.\./routes/$f'|from '@/http/$f'|g"
done
```

- [ ] **Step 4: Typecheck, lint, test**

```bash
cd /home/samuelloranger/sites/tether
bun run --cwd apps/server typecheck && bun lint && bun run --cwd apps/server test
```

Expected: all PASS.

- [ ] **Step 5: Confirm the final shape**

```bash
cd /home/samuelloranger/sites/tether/apps/server
find src -maxdepth 1 -name '*.ts' | sort
find src -mindepth 3 -name '*.ts' -not -path '*proto/gen*'
```

Expected: the first command lists exactly `src/index.ts`, `src/main.ts`, `src/serve.ts`. The second prints nothing — nothing but `proto/gen/` sits deeper than 2 levels below `src/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(server): group the Hono app and routes under http

routes/ is flattened into http/ rather than kept as http/routes/ — the
extra level buys nothing when http/ holds only the Hono app and its
route modules.

src/ is now three entry points and fifteen domain folders."
```

---

### Task 13: Full verification sweep

No code changes. This task exists because the per-task checks cover types and unit tests, but not the compiled binary against a real PTY, and not the shell scripts.

**Files:** none modified (unless a check fails).

**Interfaces:**
- Consumes: the finished tree from Task 12.
- Produces: evidence that the refactor is behavior-neutral.

- [ ] **Step 1: No stale path references anywhere**

```bash
cd /home/samuelloranger/sites/tether
grep -rn "src/server" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=superpowers .
```

Expected: no output. `docs/superpowers/` is excluded on purpose — its plans and specs are historical records of past work and must keep their original paths.

- [ ] **Step 2: No stale module basenames in imports**

```bash
cd /home/samuelloranger/sites/tether/apps/server
grep -rnE "from '(\.{1,2}/)(gitDiff|gitOps|gitRoot|gitStatus|gitWatch|workspaceFile|workspacePath|workspaceDir|pty|ptyHolder|ptyShell|ptyResize|sessionActivity|sessionTitle|signalSession|agent[A-Z]|noise[A-Z]|tls[A-Z]|push[A-Z]|deviceCli|pairCli|signalCli|controlApp|controlServe|controlSocket|presentCli|presentationRegistry|testAuth|testEvents)" src
```

Expected: no output.

- [ ] **Step 3: Clean build from scratch**

```bash
cd /home/samuelloranger/sites/tether
rm -rf apps/server/dist apps/server/src/noise/nativeLib
bun run --cwd apps/server build
ls -l apps/server/dist/tether
```

Expected: the binary exists. `build` runs `build:ffi` first, so this also re-proves the cdylib staging path.

- [ ] **Step 4: Compiled binary serves a session**

```bash
cd /home/samuelloranger/sites/tether
rm -rf /tmp/tether-task13 && mkdir -p /tmp/tether-task13
TETHER_DB_PATH=/tmp/tether-task13/tether.db TETHER_PORT=8199 TETHER_TLS=off \
  TETHER_CONTROL_SOCK=/tmp/tether-task13/control.sock \
  ./apps/server/dist/tether serve > /tmp/tether-task13/out.log 2>&1 &
probe_pid=$!
sleep 6
curl -sf http://127.0.0.1:8199/api/status; echo
kill "$probe_pid" 2>/dev/null || true
cat /tmp/tether-task13/out.log
```

Expected: `/api/status` returns JSON with a version, and the log shows no unresolved-module or missing-file errors.

- [ ] **Step 5: One end-to-end run**

```bash
cd /home/samuelloranger/sites/tether
bash scripts/e2e/run-lifecycle.sh
```

Expected: PASS. This is the check that proves the rewritten `bun apps/server/src/main.ts serve` paths in the e2e runners are correct.

- [ ] **Step 6: Full lint and both suites**

```bash
cd /home/samuelloranger/sites/tether
bun lint
bun run --cwd apps/server test
bun run --cwd apps/desktop test
```

Expected: all PASS.

- [ ] **Step 7: Confirm the diff is move-only**

```bash
cd /home/samuelloranger/sites/tether
git diff --stat main...HEAD -- apps/server/src | tail -3
git log --oneline main..HEAD
```

Review the commit list against the spec's sequence. If any commit outside Task 2 shows large non-rename content changes in `apps/server/src`, investigate — every commit after Task 2 should be moves plus import-specifier edits only.

---

### Task 14: Restructure `CLAUDE.md`

135 lines → roughly 85, same single file, sections reordered by how often an agent reaches for each.

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/terminal/session-signals.md` (the extracted narrative)
- Modify: `docs/.vitepress/config.*` if the terminal section has an explicit sidebar list

**Interfaces:**
- Consumes: the finished tree from Task 12.
- Produces: nothing code depends on.

- [ ] **Step 1: Extract the long signal narrative**

From the current "Data flow" section, move the paragraph beginning "**Session activity:** `sessionActivity.ts` classifies each session…" through "…before `UserPromptSubmit` was part of the snippet." into a new `docs/terminal/session-signals.md` with a `# Session signals` heading and a one-line intro. Update the module name it cites from `sessionActivity.ts` to `apps/server/src/pty/activity.ts`.

- [ ] **Step 2: Check the docs sidebar**

```bash
cd /home/samuelloranger/sites/tether
ls docs/terminal
grep -rn "terminal/" docs/.vitepress/config.* | head
```

If the sidebar enumerates `docs/terminal/` pages explicitly, add `session-signals` to it. If it globs, no change.

- [ ] **Step 3: Rewrite `CLAUDE.md` in this section order**

1. `## What this is` — 4 lines. Keep the POSIX-only server rule and the asymmetry that the desktop client still ships for Windows.
2. `## Commands` — moved up from third. Root scripts, per-workspace scripts, the `run test` vs `bun test` gotcha, the daemon subcommands.
3. `## Layout` — one line per domain folder, not per file. Use the Task 12 tree.
4. `## Conventions & gotchas` — absorbs the standalone "Runtime requirement" section (Bun ≥ 1.3.14 PTY floor). Add one line for the alias convention: *cross-domain imports use `@/<domain>/<module>`; same-folder imports stay relative.*
5. `## Data flow` — the six numbered steps only.
6. `## Session activity & push` — roughly 12 lines, ending with a link to `docs/terminal/session-signals.md`.
7. `## HTTP API surface` — update the heading from `` (`app.ts`) `` to `` (`src/http/`) ``.
8. `## Security note` — unchanged.

- [ ] **Step 4: Fix every file path the file names**

```bash
cd /home/samuelloranger/sites/tether
grep -nE "apps/server/src/server|src/server/|\`(pty|app|db|auth|gitDiff|gitOps|gitRoot|gitWatch|workspaceFile|upload|presentations|presentCli|push|pushCrypto|pushDevices|pushRelay|admin|x509|tlsStore|tlsConfig|tlsRuntime|noiseChannel|noiseFfi|noiseSessionProtocol|sessionActivity|sessionTitle|holder|holderFrame|procCwd|procIdentity|liveCwd|deviceToken|deviceRegistry|noiseIdentity|pairControl|config|paths|runtime|update|serve|main|index)\.ts\`" CLAUDE.md
```

Every hit must be rewritten to its new path. Cross-check each against the spec's file map — do not guess.

- [ ] **Step 5: Verify the line count and that no stale path survives**

```bash
cd /home/samuelloranger/sites/tether
wc -l CLAUDE.md
grep -n "src/server" CLAUDE.md
```

Expected: roughly 85 lines, and no `src/server` hits.

- [ ] **Step 6: Build the docs site**

```bash
bun docs:build
```

Expected: PASS. Catches a broken link to the new page.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: restructure CLAUDE.md for the new server layout

Reordered by how often an agent reaches for each section: commands and
layout ahead of the narrative. Layout is now one line per domain folder
rather than one per file, and every path is updated to the new tree.

The signal-latching narrative moves to docs/terminal/session-signals.md
and is linked rather than inlined."
```

- [ ] **Step 8: Open the PR**

```bash
cd /home/samuelloranger/sites/tether
git push -u origin refactor/server-domain-layout
gh pr create --base main --title "refactor(server): domain-grouped module layout" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-09-11-server-reorg-design.md`.

Turns the flat 170-entry `apps/server/src/server/` into 15 domain folders no
more than 2 levels below `src/`. No behavior changes — every commit is a move,
rename, reformat or config edit.

- Untracks six generated files that were committed under `src/server/config/`
  (a runtime SQLite DB plus the shell rcfiles `ptyShell.ts` writes at module
  load), and drops the untracked `src/web/` directory.
- Biome `lineWidth` 100 → 120, in its own commit so the reformat never mixes
  with a move diff. `noExcessiveLinesPerFile` stays at 400 and
  `noExcessiveLinesPerFunction` stays at 60.
- Collapses the redundant `src/server/` nesting and introduces a `@/*` tsconfig
  alias for cross-domain imports.
- Restructures `CLAUDE.md` and extracts the signal narrative into
  `docs/terminal/session-signals.md`.

Verified: `bun lint`, both test suites, a clean `bun --cwd apps/server run
build`, the compiled binary serving `/api/status`, and
`scripts/e2e/run-lifecycle.sh`.
EOF
)"
```

---

## Follow-up, not part of this plan

Files still over 400 lines after the Task 2 reformat (recorded in
`/tmp/over400-after.txt`) currently carry Biome suppressions. Splitting them is
separate work — do not attempt it here.
