# Single-Binary Tether Server — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm), pending spec review
**Motivation:** The server currently deploys as a source copy at `~/.tether/app` and
updates via `git clone + rsync + bun install` — fragile (network, registry,
lockfile drift — cf. commit `e53263a`), non-atomic, and requires bun + git + rsync +
node_modules on the box. Replace with a self-contained compiled binary.

## Goals

1. **Self-contained runtime** — one executable; no bun, git, rsync, or node_modules
   on the deployed machine.
2. **Atomic updates** — `tether update` swaps a single file; no half-updated state.
3. **One artifact** — the binary *is* `tether` (daemon + control CLI in one).
4. **Preserve data** — sessions + password DB survive install/update untouched.

## Non-goals

- Changing the server's runtime behavior (PTY, WS gateway, auth, migrations all
  unchanged).
- Signing/notarizing binaries (unsigned, like the current release IPAs/APK).
- Windows support.

## Decisions (from brainstorm)

- **Targets:** `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`.
- **CLI model:** one compiled binary, argv subcommand dispatch. The binary is `tether`.
- **Bootstrap:** hosted `install.sh` (detect OS/arch → download latest release asset →
  `~/.local/bin/tether`).
- **Versioning:** server binaries share the existing `vX.Y.Z` release tags (one release
  carries mobile IPA/APK **and** the four server binaries).
- **Cutover:** the old source-based `~/.tether/app` + git/rsync `update` is retired.
  Existing installs re-bootstrap once via `install.sh`.

## Feasibility (spike, done)

`bun build --compile --minify --outfile tether-server src/server/index.ts` produced a
**91 MB** binary that booted, ran all migrations (`bun:sqlite` embedded), served, and
enforced auth (`/` → 200, `/api/sessions` → 401). PTY (`Bun.spawn` terminal) is a bun
runtime built-in and is embedded the same way.

---

## Architecture

### Entry point unification

Today: `index.ts` bootstraps the server (reattach holders + `Bun.serve`); `cli.ts` is a
separate bun script (start/stop/status/logs/set-password/update) invoked via a PATH
symlink.

New: a single compiled entry **`apps/server/src/server/main.ts`** that dispatches on
`argv[2]`:

| Command | Action |
| --- | --- |
| *(none)* / `serve` | Run the daemon in the foreground (the current `index.ts` body). |
| `start` | Re-exec **self** (`process.execPath serve`) detached; pid+log in `~/.tether/`. |
| `stop` | Kill the pid from `~/.tether/server.pid`. |
| `status` | Report running state + HTTP liveness. |
| `logs` | `tail -f ~/.tether/server.log`. |
| `set-password` | Hidden-input prompt → argon2 hash into the DB (existing `readHidden`). |
| `update` | Download arch-matched binary from latest release, atomic-swap, restart. |
| `version` | Print embedded `TETHER_VERSION`. |
| `help` | Usage. |

The server bootstrap body currently at the top level of `index.ts` moves into an
exported `async function serve()`. Both `index.ts` (for `bun dev:server`) and `main.ts`
(compiled `serve` case) call it. `index.ts` becomes a 2-line dev entry: `import { serve }
from './serve'; serve();` (or keep the body in `index.ts` and have `main.ts` import it —
see File Structure).

### File structure

- **Create `apps/server/src/server/serve.ts`** — exports `async function serve(): Promise<void>`
  containing the reattach-holders + `Bun.serve` logic currently in `index.ts:11-28`
  plus the startup posture logs.
- **`apps/server/src/server/index.ts`** — becomes the dev entry: calls `serve()`. Keeps
  `bun dev:server` / `bun run src/server/index.ts` working unchanged.
- **Create `apps/server/src/server/main.ts`** — the compiled binary entry. Owns argv
  dispatch + all control-CLI functions (migrated from `cli.ts`), calling `serve()` for
  the `serve` case. `#!/usr/bin/env bun` shebang for dev runs.
- **Create `apps/server/src/server/paths.ts`** — shared path constants: `STATE_DIR`
  (`~/.tether`), `PID_FILE`, `LOG_FILE`, `DEFAULT_DB_PATH` (`~/.tether/config/tether.db`),
  `OLD_DB_PATH` (`~/.tether/app/config/tether.db`). Imported by `main.ts` and `db.ts`.
- **Modify `apps/server/src/server/db.ts`** — `DB_PATH` default becomes
  `process.env.TETHER_DB_PATH ?? DEFAULT_DB_PATH` (from `paths.ts`), and on startup, if
  the default is used, the default file is absent, and `OLD_DB_PATH` exists → copy it
  first (migration). `TETHER_DB_PATH` override still wins.
- **Delete `apps/server/cli.ts`** — folded into `main.ts`.
- **Create `install.sh`** (repo root).
- **Modify `.github/workflows/release.yml`** — add the `server` matrix job.
- **Modify `README.md`** — install one-liner + `tether update`.
- **Update `apps/server/package.json`** — add a `build:binary` script for local/CI use
  and (optionally) `bin` pointing at `main.ts` for dev.

### Version embedding

CI compiles with `--define 'process.env.TETHER_VERSION="<tag>"'` (the release tag). Dev
builds fall back to `dev`. `tether version` and the `update` skip-check read it.

### `tether update` flow

1. Determine `os` (`process.platform` → `linux`/`darwin`) and `arch` (`process.arch` →
   `x64`/`arm64`); asset name `tether-<os>-<arch>`.
2. `GET https://api.github.com/repos/samuelloranger/tether/releases/latest` (no auth;
   public repo) → `tag_name` + the matching asset's `browser_download_url`.
   - Repo overridable via `TETHER_REPO_SLUG` (default `samuelloranger/tether`).
3. If `tag_name === TETHER_VERSION` → print "already up to date" and exit 0.
4. Download the asset to `~/.tether/tether.new`, `chmod +x`.
5. Sanity-check: run `~/.tether/tether.new version` and confirm it prints the new tag;
   abort (leave current binary intact) if it fails.
6. Atomic replace: `rename(~/.tether/tether.new, process.execPath)`. On Linux/macOS a
   running executable's file can be replaced (the running process keeps the old inode).
7. If the daemon was running, restart it (`stop()` + `start()`), which execs the new
   binary.

Failure at any step before the rename leaves the running install untouched.

### install.sh

```
curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | sh
```
- Detect `uname -s` → `linux`/`darwin`; `uname -m` → `x86_64`→`x64`, `aarch64`/`arm64`→`arm64`.
- Resolve latest release tag via the GitHub API (or accept `TETHER_VERSION=vX.Y.Z` env to pin).
- Download `tether-<os>-<arch>` to `~/.local/bin/tether`, `chmod +x`.
- If `~/.local/bin` not on PATH, print the export line to add.
- One-time migration note: if `~/.tether/app` exists, tell the user the DB will be
  migrated automatically on first run and that `~/.tether/app` can be deleted.

## Cutover / migration

- **DB:** first run of the binary copies `~/.tether/app/config/tether.db` →
  `~/.tether/config/tether.db` when the new one is absent (handled in `db.ts`).
- **PATH entry:** `install.sh` overwrites `~/.local/bin/tether` (previously a symlink to
  `cli.ts`) with the real binary.
- **Old source tree:** `~/.tether/app` and `~/.tether/src` become dead; `install.sh`
  notes they can be removed. Not auto-deleted (avoid destroying anything unexpected).
- **Docs:** README switches the install/update instructions to the binary flow.

## Testing

No UI here; verification is CLI/integration. Where a pure unit exists, test it; the rest
is exercised end-to-end in an isolated `HOME`.

- **Pure/unit (custom `ok()` script style, run via `bun run`):**
  - asset-name resolution: `(platform, arch) → "tether-<os>-<arch>"` for the 4 targets +
    an unsupported arch → clear error.
  - version skip logic: `shouldUpdate(current, latest)` → false when equal, true when
    different.
- **Integration (isolated `HOME`, real binary):**
  - `bun build --compile` for the host target succeeds; binary boots, migrates, serves,
    `/api/sessions` → 401 (already spiked; formalize as a build-smoke step).
  - `tether version` prints the `--define`'d version.
  - `tether start` → pid file written, `status` shows running, HTTP ok; `stop` clears it.
  - DB migration: seed `~/.tether/app/config/tether.db`, first run copies it to the new
    path; `TETHER_DB_PATH` override bypasses migration.
  - `install.sh` arch detection via a dry-run mode (`DRY_RUN=1` prints the resolved asset
    URL + target path without downloading).
- **CI:** the `server` matrix job must compile all four targets (compile failure fails
  the release).

## Open questions

None blocking. macOS binaries are unsigned (Gatekeeper will require a manual
right-click-open or `xattr -d com.apple.quarantine`) — documented in README, consistent
with the current unsigned mobile artifacts.
