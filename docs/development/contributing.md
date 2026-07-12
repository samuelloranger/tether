# Contributing

## Prerequisites

Bun **≥ 1.3.14** (PTY support). Install workspaces from the repo root:

```sh
bun install
```

## Run from source

```sh
bun dev:server     # backend on :8085, watch mode
bun dev:mobile     # Expo Metro bundler
```

Source runs use a repo-local `apps/server/config/tether.db`, isolated from any installed binary. Override with `TETHER_DB_PATH`.

## Build the binary

```sh
bun build:server   # compiles apps/server/dist/tether
bun start:server   # runs the compiled binary
```

## Checks

```sh
bun lint                          # Biome (server) + Expo lint (mobile)
bun format                        # biome check --write (server)
bun --cwd apps/server typecheck   # tsc --noEmit
```

There is no test runner; unit tests are plain scripts run with `bun run <file>.test.ts` (server) or `bun test` from a package dir, using a small custom `ok`/`eq` harness.

## Conventions

- Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100.
- SQLite uses `$name` named params. Schema changes append a new **versioned, idempotent** entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Mobile: read the exact Expo 57 docs (`https://docs.expo.dev/versions/v57.0.0/`) before writing Expo code.
