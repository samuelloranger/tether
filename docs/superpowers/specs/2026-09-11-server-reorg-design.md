# Server code reorganization

**Date:** 2026-09-11
**Scope:** `apps/server` module layout, `biome.json`, root `CLAUDE.md`
**Status:** approved, ready for implementation plan

## Problem

`apps/server/src/server/` holds 170 entries in one flat directory — 81 source
files, 81 test files, plus `routes/` (13), `proto/` (7), and two directories
that do not belong in source at all. Nothing about the tree tells you which
files change together. The only grouping that exists (`routes/`, `proto/`) was
applied to two areas and never extended.

Three separate problems ride along with it:

1. `apps/server/src/server/config/` is **runtime output committed to git**.
   `ptyShell.ts:65-66` writes `zsh/.zshrc` and `zsh/.zshenv` at module load;
   the same module writes `tether.bashrc`. `paths.ts:22` resolves the dev DB to
   `path.join(process.cwd(), 'config', 'tether.db')`. Someone ran the server
   with cwd = `apps/server/src/server`, and `.gitignore` only covers
   `apps/server/config/`, so `tether.db`, `tether.db-shm`, `tether.db-wal`,
   `tether.bashrc`, `zsh/.zshrc` and `zsh/.zshenv` were committed in
   `2b8ad1d5`. None of the six is a source asset.
2. `apps/server/src/web/` has **zero tracked files** and contains
   `node_modules/` and `dist/`.
3. `biome.json` sets `lineWidth: 100`, which wraps aggressively in a codebase
   with long generic signatures and chained Hono handlers.

## Decisions

| Decision | Choice |
|---|---|
| Grouping | By domain — one folder per feature area |
| Nesting | Collapse `apps/server/src/server/` → `apps/server/src/` |
| Filenames | Drop the redundant domain prefix (`gitDiff.ts` → `git/diff.ts`) |
| Cross-domain imports | tsconfig path alias `@/*` → `./src/*` |
| `CLAUDE.md` | Trim and reorder in place, single file |
| Delivery | One PR, thirteen ordered commits |
| `lineWidth` | 100 → 120 |
| `noExcessiveLinesPerFile` | Keep at 400 |
| `noExcessiveLinesPerFunction` | Keep at 60 |

Max depth is 2 levels below `src/`. Only `proto/gen/` reaches 2; every domain
folder is 1.

## Target tree

```
apps/server/src/
  main.ts                  argv dispatch + control CLI + holder subcommand
  index.ts                 dev entry
  serve.ts                 reattach holders + http/https listeners

  pty/           17   PTY lifecycle, holders, cwd tracking, replay
  agent/          8   agent drivers, registry, message mapping
  auth/           9   device identity, bearer tokens, pairing, enrollment
  noise/          6   Noise IK channel, FFI, identity, session protocol
  tls/            4   listener plan, cert store, runtime report, x509
  git/            7   diff, ops, status, root, watch
  workspace/      4   file read, path resolution, dir listing, upload
  push/           5   encrypted APNs push via relay, notification triggers
  presentations/  3   HTML preview registry, shared instance, CLI
  cli/            5   CLI subcommands that are not the server itself
  control/        3   loopback control socket the CLI talks to
  http/          12   Hono app + every route module
  infra/          6   db, log, paths, runtime, settings, test hooks
  testing/        1   test-only helpers
  proto/          2   wire frame + codec, plus gen/
```

### Why these boundaries

- **`noise/` and `tls/` are siblings, not one `transport/`.** A single
  `transport/` folder would force the files to keep their `noise`/`tls` prefixes
  to stay distinguishable, defeating the prefix-drop decision. Split, the
  prefixes fall away naturally.
- **`routes/` is flattened into `http/`, not kept as `http/routes/`.** The extra
  level buys nothing — `http/` contains only the Hono app and its route modules.
- **`infra/config.ts` is renamed `infra/settings.ts`.** `config.ts` (the
  zod-typed settings table) and `routes/config.ts` (the HTTP surface over it)
  currently read as near-twins. `infra/settings.ts` + `http/config.ts` do not.
- **`pty.ts` → `pty/registry.ts`, `ptyHolder.ts` → `pty/holderClient.ts`,
  `holder.ts` stays `pty/holder.ts`.** `holder.ts` is the detached process that
  owns a PTY; `ptyHolder.ts` is the server-side client that talks to it. The old
  names invited confusing the two.
- **`testEvents.ts` goes to `infra/`, not `testing/`.** It is imported by
  `app.ts`, `pty.ts` and `noiseSessionProtocol.ts` — production code. Only
  `testAuth.ts` is genuinely test-only.

## File map — source

Every path below is relative to `apps/server/src/`. Old paths are relative to
`apps/server/src/server/`.

### `pty/` (17)

| Old | New |
|---|---|
| `pty.ts` | `pty/registry.ts` |
| `ptyHolder.ts` | `pty/holderClient.ts` |
| `holder.ts` | `pty/holder.ts` |
| `holderFrame.ts` | `pty/holderFrame.ts` |
| `ptyShell.ts` | `pty/shell.ts` |
| `ptyResize.ts` | `pty/resize.ts` |
| `spawnLimits.ts` | `pty/spawnLimits.ts` |
| `procCwd.ts` | `pty/procCwd.ts` |
| `procIdentity.ts` | `pty/procIdentity.ts` |
| `liveCwd.ts` | `pty/liveCwd.ts` |
| `cwdRefresh.ts` | `pty/cwdRefresh.ts` |
| `sessionActivity.ts` | `pty/activity.ts` |
| `sessionTitle.ts` | `pty/title.ts` |
| `signalSession.ts` | `pty/signal.ts` |
| `replayCursor.ts` | `pty/replayCursor.ts` |
| `replayPlan.ts` | `pty/replayPlan.ts` |
| `replayRead.ts` | `pty/replayRead.ts` |

### `agent/` (8)

| Old | New |
|---|---|
| `agentDriver.ts` | `agent/driver.ts` |
| `agentClaudeDriver.ts` | `agent/claudeDriver.ts` |
| `agentEventMap.ts` | `agent/eventMap.ts` |
| `agentMessages.ts` | `agent/messages.ts` |
| `agentRegistry.ts` | `agent/registry.ts` |
| `agentReplay.ts` | `agent/replay.ts` |
| `agentUsage.ts` | `agent/usage.ts` |
| `claudeSessions.ts` | `agent/claudeSessions.ts` |

### `auth/` (9)

| Old | New |
|---|---|
| `auth.ts` | `auth/bearer.ts` |
| `authGate.ts` | `auth/gate.ts` |
| `deviceToken.ts` | `auth/deviceToken.ts` |
| `deviceRegistry.ts` | `auth/deviceRegistry.ts` |
| `deviceChannels.ts` | `auth/deviceChannels.ts` |
| `enrollment.ts` | `auth/enrollment.ts` |
| `pairControl.ts` | `auth/pairControl.ts` |
| `pairAdvertise.ts` | `auth/pairAdvertise.ts` |
| `pairQr.ts` | `auth/pairQr.ts` |

### `noise/` (6 + generated dir)

| Old | New |
|---|---|
| `noiseChannel.ts` | `noise/channel.ts` |
| `noiseFfi.ts` | `noise/ffi.ts` |
| `noiseIdentity.ts` | `noise/identity.ts` |
| `noiseSessionProtocol.ts` | `noise/sessionProtocol.ts` |
| `noiseWsAdapter.ts` | `noise/wsAdapter.ts` |
| `noiseNativeLib.d.ts` | `noise/nativeLib.d.ts` |
| `noiseNativeLib/` (generated) | `noise/nativeLib/` |

### `tls/` (4)

| Old | New |
|---|---|
| `tlsConfig.ts` | `tls/config.ts` |
| `tlsRuntime.ts` | `tls/runtime.ts` |
| `tlsStore.ts` | `tls/store.ts` |
| `x509.ts` | `tls/x509.ts` |

### `git/` (7)

| Old | New |
|---|---|
| `gitDiff.ts` | `git/diff.ts` |
| `gitOps.ts` | `git/ops.ts` |
| `gitRoot.ts` | `git/root.ts` |
| `gitStatus.ts` | `git/status.ts` |
| `gitWatch.ts` | `git/watch.ts` |
| `gitWatchIgnore.ts` | `git/watchIgnore.ts` |
| `gitWatchIgnoredDirs.ts` | `git/watchIgnoredDirs.ts` |

### `workspace/` (4)

| Old | New |
|---|---|
| `workspaceFile.ts` | `workspace/file.ts` |
| `workspacePath.ts` | `workspace/path.ts` |
| `workspaceDir.ts` | `workspace/dir.ts` |
| `upload.ts` | `workspace/upload.ts` |

### `push/` (5)

| Old | New |
|---|---|
| `push.ts` | `push/send.ts` |
| `pushCrypto.ts` | `push/crypto.ts` |
| `pushDevices.ts` | `push/devices.ts` |
| `pushRelay.ts` | `push/relay.ts` |
| `notifications.ts` | `push/notifications.ts` |

### `presentations/` (3)

| Old | New |
|---|---|
| `presentations.ts` | `presentations/registry.ts` |
| `presentationRegistry.ts` | `presentations/instance.ts` |
| `presentCli.ts` | `presentations/cli.ts` |

The old names were inverted: `presentations.ts` defines the
`PresentationRegistry` class, `resolvePresentationFile` and the `Presentation`
type, while `presentationRegistry.ts` holds nothing but the shared singleton
(`export const presentations = new PresentationRegistry()`). The new names put
the class in `registry.ts` and the singleton in `instance.ts`.

### `cli/` (5)

| Old | New |
|---|---|
| `deviceCli.ts` | `cli/device.ts` |
| `pairCli.ts` | `cli/pair.ts` |
| `signalCli.ts` | `cli/signal.ts` |
| `logTail.ts` | `cli/logTail.ts` |
| `update.ts` | `cli/update.ts` |

### `control/` (3)

| Old | New |
|---|---|
| `controlApp.ts` | `control/app.ts` |
| `controlServe.ts` | `control/serve.ts` |
| `controlSocket.ts` | `control/socket.ts` |

### `http/` (12)

| Old | New |
|---|---|
| `app.ts` | `http/app.ts` |
| `admin.ts` | `http/admin.ts` |
| `routes/config.ts` | `http/config.ts` |
| `routes/files.ts` | `http/files.ts` |
| `routes/fs.ts` | `http/fs.ts` |
| `routes/git.ts` | `http/git.ts` |
| `routes/noise.ts` | `http/noise.ts` |
| `routes/presentations.ts` | `http/presentations.ts` |
| `routes/previewMime.ts` | `http/previewMime.ts` |
| `routes/sessionCwd.ts` | `http/sessionCwd.ts` |
| `routes/sessions.ts` | `http/sessions.ts` |
| `routes/terminalCodec.ts` | `http/terminalCodec.ts` |

### `infra/` (6)

| Old | New |
|---|---|
| `db.ts` | `infra/db.ts` |
| `log.ts` | `infra/log.ts` |
| `paths.ts` | `infra/paths.ts` |
| `runtime.ts` | `infra/runtime.ts` |
| `config.ts` | `infra/settings.ts` |
| `testEvents.ts` | `infra/testEvents.ts` |

### `testing/` (1)

| Old | New |
|---|---|
| `testAuth.ts` | `testing/auth.ts` |

### `proto/` (2 + gen)

Unchanged except for the collapsed parent: `proto/frame.ts`,
`proto/wireCodec.ts`, `proto/gen/`.

### Entry points (3)

`main.ts`, `index.ts`, `serve.ts` stay at `src/` root.

**Total: 93 source files.**

## File map — tests

Each test moves to its module's folder and takes the module's new base name.
Compound test names keep their suffix.

Representative cases:

| Old | New |
|---|---|
| `gitDiff.test.ts` | `git/diff.test.ts` |
| `gitDiff.api.test.ts` | `git/diff.api.test.ts` |
| `auth.test.ts` | `auth/bearer.test.ts` |
| `config.test.ts` | `infra/settings.test.ts` |
| `config.api.test.ts` | `http/config.api.test.ts` |
| `pty.env.test.ts` | `pty/registry.env.test.ts` |
| `pty.exitGuard.test.ts` | `pty/registry.exitGuard.test.ts` |
| `pty.kill.test.ts` | `pty/registry.kill.test.ts` |
| `pty.liveCwd.test.ts` | `pty/registry.liveCwd.test.ts` |
| `pty.shell.test.ts` | `pty/registry.shell.test.ts` |
| `pty.title.test.ts` | `pty/registry.title.test.ts` |
| `ptyHolder.negotiate.test.ts` | `pty/holderClient.negotiate.test.ts` |
| `sessionActivity.test.ts` | `pty/activity.test.ts` |
| `sessionActivity.api.test.ts` | `pty/activity.api.test.ts` |
| `sessionTitle.test.ts` | `pty/title.test.ts` |
| `sessionTitle.api.test.ts` | `pty/title.api.test.ts` |
| `signal.api.test.ts` | `pty/signal.api.test.ts` |
| `signalCli.test.ts` | `cli/signal.test.ts` |
| `push.test.ts` | `push/send.test.ts` |
| `presentations.test.ts` | `presentations/registry.test.ts` |
| `presentCli.test.ts` | `presentations/cli.test.ts` |
| `admin.api.test.ts` | `http/admin.api.test.ts` |
| `app.rateLimit.test.ts` | `http/app.rateLimit.test.ts` |
| `dbStartup.test.ts` | `infra/dbStartup.test.ts` |
| `tls.api.test.ts` | `tls/api.test.ts` |
| `update.digest.test.ts` | `cli/update.digest.test.ts` |
| `update.swap.test.ts` | `cli/update.swap.test.ts` |

The remaining tests follow the same rule mechanically from the source map.
`routes/fs.test.ts`, `routes/sessions.test.ts` and `routes/terminalCodec.test.ts`
move to `http/`. `proto/frame.test.ts` and `proto/wireCodec.test.ts` stay.

**Total: 86 test files.**

Name-collision check across the whole map: `pty/title.test.ts` vs
`pty/registry.title.test.ts`, `cli/signal.test.ts` vs `pty/signal.api.test.ts`,
`tls/config.ts` vs `infra/settings.ts` vs `http/config.ts`, `tls/runtime.ts` vs
`infra/runtime.ts`, `control/app.ts` vs `http/app.ts`, `control/serve.ts` vs
`src/serve.ts`, `http/git.ts` vs `git/`, `http/noise.ts` vs `noise/` — all
distinct paths, no collisions.

## Import style

Add to `apps/server/tsconfig.json`:

```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

- Same-folder imports stay relative: `import { parseDiff } from './diff';`
- Cross-domain imports use the alias: `import { getDb } from '@/infra/db';`

Verified: `bun build --compile` resolves the alias correctly (scratch repro
compiled and ran). `bun test` and `tsc --noEmit` both read tsconfig `paths`
under `moduleResolution: "bundler"`, which this project already uses.

`scripts/e2e/preseed-fixture.ts` lives outside `apps/server` and is not covered
by that tsconfig — it keeps relative imports, updated to the new paths.

## Configuration changes

### `biome.json`

```diff
-    "lineWidth": 100
+    "lineWidth": 120
```

```diff
-      "!apps/server/src/server/proto/gen"
+      "!apps/server/src/proto/gen"
```

`noExcessiveLinesPerFile` stays at 400 and `noExcessiveLinesPerFunction` stays
at 60.

Note how the per-file rule actually counts: it measures **code** lines, not
physical ones, and it skips blank lines and comments. Three non-test files
exceed 400 physical lines (`db.ts` 458, `noiseSessionProtocol.ts` 437,
`ptyHolder.ts` 428) and all three pass the rule cleanly — none carries a
suppression. So the rule is active and enforcing, just against a different
measure than `wc -l`; verified by dropping `maxLines` to 10, which makes it fire
on `db.ts` immediately.

### `apps/server/package.json`

| Field | Old | New |
|---|---|---|
| `bin.tether` | `./src/server/main.ts` | `./src/main.ts` |
| `scripts.dev` | `bun run --watch src/server/index.ts` | `bun run --watch src/index.ts` |
| `scripts.build:binary` | `… --outfile dist/tether src/server/main.ts` | `… --outfile dist/tether src/main.ts` |

### `.gitignore`

- Remove `apps/server/src/web/dist/` (directory is being deleted).
- Change `apps/server/config/` to `apps/server/**/config/` so a run with a
  stray cwd can never recommit a runtime config dir.
- `apps/server/.gitignore` gets the same treatment for its local `src/web/dist/`
  and `config/*.db` entries.

## References outside `apps/server/src` that must be updated

| File | Line | What |
|---|---|---|
| `.github/workflows/release.yml` | 614 | `src/server/main.ts` |
| `.github/workflows/release.yml` | 582 | comment naming `apps/server/src/server/noiseNativeLib` |
| `.github/workflows/ci.yml` | 38 | comment naming `apps/server/src/server/noiseFfi.ts` |
| `scripts/build-ffi.ts` | 54 | FFI output dest → `apps/server/src/noise/nativeLib` |
| `scripts/build-ffi.ts` | 3 | comment |
| `scripts/scratch-server.sh` | 5, 113 | `apps/server/src/server/main.ts` |
| `scripts/e2e/preseed-fixture.ts` | 8-10 | imports of `deviceRegistry`, `noiseFfi`, `noiseIdentity` |
| `scripts/e2e/run-tab-switch.sh` | 31 | `bun apps/server/src/server/main.ts serve` |
| `scripts/e2e/run-preseed-connect.sh` | 34 | same |
| `scripts/e2e/run-agent-scrollback.sh` | 51 | same |
| `scripts/e2e/run-multihost.sh` | 27, 30 | same, twice |
| `scripts/e2e/run-lifecycle.sh` | 36 | same |
| `scripts/e2e/run-reconnect-replay.sh` | 31 | same |
| `scripts/e2e/run-server-restart.sh` | 27 | same |
| `scripts/e2e/run-reconnect-input.sh` | 30 | same |
| `scripts/e2e/run-bg-accumulation.sh` | 33 | same |
| `scripts/e2e/run-scrollback.sh` | 31 | same |
| `apps/server/src/infra/paths.ts` | 15 | comment naming the dev DB path |
| `apps/server/src/tls/store.ts` | 16 | comment naming `config/tether.db` |

Verify no reference was missed with
`grep -rn "src/server" --exclude-dir=node_modules --exclude-dir=.git .`
returning nothing after the move.

## `CLAUDE.md` restructure

135 lines → approximately 85, same single file. New section order, chosen by how
often an agent needs each one:

1. **What this is** — 4 lines. Keeps the POSIX-only server note and the "desktop
   client still ships for Windows" asymmetry.
2. **Commands** — moved up from third. Root scripts, per-workspace scripts, the
   `run test` vs `bun test` gotcha, the daemon subcommands.
3. **Layout** — rewritten to the new tree, one line per domain folder rather
   than the current per-file enumeration.
4. **Conventions & gotchas** — absorbs the standalone "Runtime requirement"
   section (Bun ≥ 1.3.14 PTY floor) and adds the `@/*` alias convention.
5. **Data flow** — trimmed to the six numbered steps.
6. **Session activity & push** — compressed from about 40 lines to about 12.
7. **HTTP API surface**
8. **Security note**

The long narrative on signal latching and `done` semantics moves into `docs/`
(the VitePress site already has `architecture.md` and `data-flow.md`) and is
linked from section 6.

## Commit sequence

One branch, one PR, thirteen commits in this order:

1. `chore(server): untrack accidental runtime config dir`
   `git rm --cached` the six files under `src/server/config/`, delete
   `apps/server/src/web/`, widen the `.gitignore` patterns.
2. `style: biome lineWidth 100 -> 120`
   Config change plus `bun format`. Nothing else in this commit.
3. `refactor(server): collapse src/server -> src`
   Pure path change. Every external reference in the table above.
4. `refactor(server): move infra and test helpers into folders` — also adds the
   `@/*` alias, since `infra/` is its first consumer.
5. `refactor(server): group pty modules`
6. `refactor(server): group agent modules`
7. `refactor(server): group auth, device and pairing modules`
8. `refactor(server): split noise and tls into sibling folders`
9. `refactor(server): group git and workspace modules`
10. `refactor(server): group push and presentation modules`
11. `refactor(server): group cli subcommands and the control surface`
12. `refactor(server): group the Hono app and routes under http`
13. `docs: restructure CLAUDE.md`

The domain move is split one folder-group per commit rather than landing as a
single commit. Each one leaves the tree green — `tsc --noEmit` plus the full
suite pass after every commit — so a bisect lands on a working tree and a
reviewer can read one domain at a time. `infra/` goes first because it carries
the highest fan-in (`db` alone has 33 importers), which exercises the alias
across nearly the whole tree in one step.

Commit 2 stays alone so the reformat diff never mixes with a move diff, and so
`git log --follow` survives on the moved files.

## Verification

After every commit:

- `bun lint` — Biome plus the server and desktop typechecks
- `bun --cwd apps/server run test`

After commit 4, additionally:

- `bun --cwd apps/server run build` — proves the alias survives
  `bun build --compile` in the real build, not just the scratch repro
- `bash scripts/e2e/run-lifecycle.sh` — proves the rewritten shell-script paths
  and the compiled binary both still work
- `grep -rn "src/server" --exclude-dir=node_modules --exclude-dir=.git .`
  returns nothing

## Out of scope

- Splitting any file that is currently over 400 lines. The audit happens after
  the reformat; the splits, if any, are separate work.
- Any behavior change. Every commit is a pure move, rename, reformat or config
  edit — no logic is touched.
- `apps/desktop`, `clients/apple`, `apps/relay`, `crates/`. Only `apps/server`,
  `biome.json`, `.gitignore`, `scripts/`, `.github/workflows/` and `CLAUDE.md`
  are touched.
