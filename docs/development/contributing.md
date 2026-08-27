# Contributing

## Prerequisites

Bun **≥ 1.3.14** (PTY support). Install workspaces from the repo root:

```sh
bun install
```

## Run from source

```sh
bun dev:server     # backend on :8085, watch mode
bun dev:desktop    # the Tauri desktop client (apps/desktop)
```

The iOS client is a native Xcode project (`clients/apple`). It links the Rust
core as a prebuilt XCFramework, so run `scripts/build-xcframework.sh` after any
change under `crates/` — otherwise Xcode links the previous binary and your
change is simply absent from the app.

Source runs use a repo-local `apps/server/config/tether.db`, isolated from any installed binary. Override with `TETHER_DB_PATH`.

## Build the binary

```sh
bun build:server   # compiles apps/server/dist/tether
bun start:server   # runs the compiled binary
```

## Checks

```sh
bun lint                            # Biome + typecheck every workspace
bun format                          # biome check --write

bun --cwd apps/server run test      # server suite (bun:test)
bun --cwd apps/desktop run test     # desktop logic suite
bun test scripts/                   # release tooling, incl. the updater manifest

cd crates/tether-core && cargo test # the shared core, plus its e2e suites
cd apps/desktop/src-tauri && cargo test
```

Use `run test`, not a bare `bun test`: the built-in runner wins over the script
name and silently drops the `--parallel` flag the scripts carry.

The core's e2e suites spawn the **real compiled server**, one per test on its own
port and temp database, so build it first with `bun build:server` — they assert
the binary exists rather than falling back to a mock.

## Conventions

- Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100.
- SQLite uses `$name` named params. Schema changes append a new **versioned, idempotent** entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Tests live next to what they test (`foo.ts` + `foo.test.ts`). New logic is
  expected to come with them; keep pure logic in its own module so it is testable
  without a PTY.
- Runtime state lives in `~/.tether/` (`config/tether.db`, `holders/`, pid, log).
  `TETHER_DB_PATH` overrides the DB.
