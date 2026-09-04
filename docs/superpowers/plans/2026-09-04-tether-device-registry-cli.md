# Tether Device Registry + Management CLI (Plan 2b of 5)

> **For the implementing agent (Cursor):** Implement this plan task-by-task, TDD, committing after each task. This is a slice of a larger security rework; build EXACTLY the interface specified here — a sibling plan (2c) consumes `deviceRegistry.ts` by these exact signatures, so do not rename or reshape them.

**Goal:** Add a persistent registry of authorized device public keys (the `authorized_keys`-style allow-list for the new Noise auth) and the CLI to list/revoke/rename devices. **No pairing, no WebSocket, no crypto handshake here** — that is a separate plan. This slice is pure data + CLI and is fully unit-testable with `bun:test`.

**Repo:** `/home/samuelloranger/sites/tether/.worktrees/2b` (a git worktree on branch `noise-registry-cli`). It is the Tether monorepo. The server is `apps/server` (Bun + Hono, `bun:sqlite`). Source lives in `apps/server/src/server/`.

**Read before starting:**
- `apps/server/src/server/db.ts` — the `bun:sqlite` setup, the `migrations` array (append-only; last version is 8 = `push_devices`), `runMigrations()`, and existing exported query functions (`getSession`, `setSetting`, etc.). Follow these patterns exactly — `$name` named params, one exported function per operation.
- `apps/server/src/server/main.ts` — the CLI dispatch: `const cmd = process.argv[2] ?? 'serve'; switch (cmd) { case 'serve': … case 'present': { const { parsePresentArgs, runPresent } = await import('./presentCli'); … } … }`. New verbs are added as `case` blocks that dynamically import a CLI module, mirroring the `present` case.
- `apps/server/src/server/presentCli.ts` — the pattern for a CLI module with an arg parser + a runner, and its sibling `presentCli.test.ts` for the test style.
- `apps/server/CLAUDE.md` / repo `CLAUDE.md` — build/test commands.

**Commands (run from repo root `.worktrees/2b`):**
- Server tests: `bun --cwd apps/server run test` (bun:test, parallel). Run a single file: `bun --cwd apps/server test deviceRegistry`.
- Never pin `TETHER_DB_PATH` for a suite run — `apps/server/test-preload.ts` gives each test process its own temp DB. Tests here should use their own in-memory or temp DB per the existing pattern; check how `db.test.ts` isolates state.
- Typecheck: `bun --cwd apps/server run typecheck`. Lint: `bunx biome check <files>`.
- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bunx biome check --write <files>` before committing.

## Global Constraints

- **Append-only migrations.** Add a new entry `{ version: 9, name: 'auth_devices', up: '…' }` to the `migrations` array in `db.ts`. NEVER edit an applied migration.
- **`pubkey` is the identity.** It is the base64 encoding of a device's 32-byte X25519 static public key. It is UNIQUE. A second `addDevice` with the same pubkey is an error (`RegistryError` code `duplicate`).
- **`fingerprint`** is the lowercase hex of `SHA-256(pubkey_raw_bytes)` (hash the 32 raw bytes, not the base64 string). Store the full 64-hex; the CLI matches by prefix and displays the first 8.
- **Revoke/rename target resolution:** a target string matches EITHER an exact `label` OR a `fingerprint` prefix (≥1 char). If it matches zero rows → `RegistryError` code `not_found`. If it matches more than one → `RegistryError` code `ambiguous`. Never guess.
- **This slice does NOT tear down live connections or touch `push_devices`.** Revoke here removes the `auth_devices` row only. (Plan 2c wires live-WS teardown + push-row deletion onto this.) Leave a `// Plan 2c:` comment where that hook will go.
- Colocated tests: `foo.ts` + `foo.test.ts`.

---

## File Structure

- Modify `apps/server/src/server/db.ts` — add migration version 9 (`auth_devices` table).
- Create `apps/server/src/server/deviceRegistry.ts` — the registry module (the interface below).
- Create `apps/server/src/server/deviceRegistry.test.ts` — its tests.
- Create `apps/server/src/server/deviceCli.ts` — arg parser + runner for `devices` / `device` verbs.
- Create `apps/server/src/server/deviceCli.test.ts` — its tests.
- Modify `apps/server/src/server/main.ts` — add `case 'devices'` and `case 'device'` dispatch blocks and their `--help` lines.

---

## The Registry Interface (build EXACTLY this — Plan 2c depends on it)

```ts
// deviceRegistry.ts
export interface AuthDevice {
  id: string; // uuid v4
  label: string;
  pubkey: string; // base64 of the 32-byte X25519 static public key
  fingerprint: string; // lowercase hex of SHA-256(raw pubkey bytes)
  pairedAt: string; // ISO-8601
  lastSeenAt: string | null;
  lastAddress: string | null;
}

export class RegistryError extends Error {
  constructor(public code: 'not_found' | 'ambiguous' | 'duplicate', message: string);
}

// Insert a newly-authorized device. Computes id + fingerprint. Throws
// RegistryError('duplicate') if the pubkey is already present.
export function addDevice(input: { label: string; pubkey: string; address?: string }): AuthDevice;

// All devices, newest-paired first.
export function listDevices(): AuthDevice[];

// The authorization lookup Plan 2c calls after a completed IK handshake:
// returns the device for this static pubkey, or null (⇒ drop the connection).
export function getDeviceByPubkey(pubkey: string): AuthDevice | null;

// Update last_seen_at (now) and last_address on a successful reconnect. No-op if
// the pubkey is unknown.
export function touchDevice(pubkey: string, address?: string): void;

// Resolve a CLI target (exact label OR fingerprint prefix) to exactly one device.
// Throws RegistryError('not_found' | 'ambiguous').
export function resolveTarget(target: string): AuthDevice;

// Remove a device by target (uses resolveTarget). Returns the removed device.
// Plan 2c will additionally tear down its live connection + push row.
export function revokeDevice(target: string): AuthDevice;

// Rename a device by target. Returns the updated device.
export function renameDevice(target: string, label: string): AuthDevice;

export function deviceCount(): number;
```

---

## Task 1: `auth_devices` migration + `addDevice` / `listDevices` / `getDeviceByPubkey`

**Files:**
- Modify: `apps/server/src/server/db.ts`
- Create: `apps/server/src/server/deviceRegistry.ts`
- Create: `apps/server/src/server/deviceRegistry.test.ts`

- [ ] **Step 1: Add the migration.** Append to the `migrations` array in `db.ts`:

```ts
  {
    version: 9,
    name: 'auth_devices',
    // One row per authorized device public key — the authorized_keys allow-list
    // for Noise auth. pubkey is base64 of the 32-byte X25519 static key, unique.
    up: `
      CREATE TABLE IF NOT EXISTS auth_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        pubkey TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        paired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME,
        last_address TEXT
      );
    `,
  },
```

- [ ] **Step 2: Write failing tests** in `deviceRegistry.test.ts` for: `addDevice` returns a device with a uuid `id`, a 64-hex `fingerprint`, and `pairedAt` set; `listDevices` returns inserted rows newest-first; `getDeviceByPubkey` finds an inserted device and returns `null` for an unknown pubkey; a duplicate pubkey throws `RegistryError` with `code === 'duplicate'`. Import the db access the same way sibling tests do (check `db.test.ts` for how it gets a clean DB — the test-preload gives each process its own temp DB, so `runMigrations()` then use the exported functions).

  Use a real 32-byte pubkey encoded as base64, e.g. `Buffer.from(new Uint8Array(32).fill(7)).toString('base64')`, and vary the fill for distinct devices.

- [ ] **Step 3: Run to confirm failure.** `bun --cwd apps/server test deviceRegistry` → FAIL.

- [ ] **Step 4: Implement** `AuthDevice`, `RegistryError`, `addDevice`, `listDevices`, `getDeviceByPubkey` in `deviceRegistry.ts`. Compute `fingerprint` with Bun's crypto: `new Bun.CryptoHasher('sha256').update(Buffer.from(pubkey, 'base64')).digest('hex')`. Compute `id` with `crypto.randomUUID()`. Map DB snake_case columns to the camelCase `AuthDevice` shape in a small row-mapper. Catch the SQLite UNIQUE-constraint violation on insert and rethrow as `RegistryError('duplicate', …)`.

- [ ] **Step 5: Run to confirm pass.** `bun --cwd apps/server test deviceRegistry` → PASS.

- [ ] **Step 6: Commit.** `git add apps/server/src/server/db.ts apps/server/src/server/deviceRegistry.ts apps/server/src/server/deviceRegistry.test.ts && git commit -m "feat(devices): auth_devices table + registry insert/list/lookup"`

---

## Task 2: `resolveTarget`, `revokeDevice`, `renameDevice`, `touchDevice`, `deviceCount`

**Files:**
- Modify: `apps/server/src/server/deviceRegistry.ts`
- Modify: `apps/server/src/server/deviceRegistry.test.ts`

- [ ] **Step 1: Write failing tests:** `resolveTarget` finds by exact label and by fingerprint prefix; throws `not_found` for no match and `ambiguous` when a prefix matches two devices (insert two devices whose fingerprints share a leading char — or match by a short common prefix; if fingerprints don't collide, test ambiguity by two devices with the same label). `revokeDevice` removes the row and returns it, and a second revoke of the same target throws `not_found`. `renameDevice` changes the label and returns the updated device. `touchDevice` sets `lastSeenAt`/`lastAddress` and is a no-op for an unknown pubkey. `deviceCount` reflects inserts and revokes.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement** the five functions. `resolveTarget`: query `WHERE label = $t` and `WHERE fingerprint LIKE $t || '%'`, union the id set; 0 → `not_found`, >1 → `ambiguous`, else return the one device. `revokeDevice`/`renameDevice` call `resolveTarget` then mutate by `id`. `touchDevice` runs an `UPDATE … WHERE pubkey = $pubkey` (0 rows updated is a silent no-op). `deviceCount` is `SELECT COUNT(*)`.

- [ ] **Step 4: Run to confirm pass.**

- [ ] **Step 5: Commit.** `git commit -am "feat(devices): resolveTarget + revoke/rename/touch/count"`

---

## Task 3: `deviceCli.ts` — arg parsing + runner

**Files:**
- Create: `apps/server/src/server/deviceCli.ts`
- Create: `apps/server/src/server/deviceCli.test.ts`

The CLI has two entry verbs: `tether devices` (list) and `tether device <sub> …` where `<sub>` ∈ `revoke <target>` | `rename <target> <label>`.

- [ ] **Step 1: Write failing tests** for a pure `parseDeviceArgs(argv: string[])` that returns a discriminated union:
  - `[]` (the `devices` verb passes no extra argv) → `{ kind: 'list' }`
  - `['revoke', 'sam-iphone']` → `{ kind: 'revoke', target: 'sam-iphone' }`
  - `['rename', '7q4k', 'laptop']` → `{ kind: 'rename', target: '7q4k', label: 'laptop' }`
  - malformed (`['revoke']` with no target, `['bogus']`, `rename` missing label) → throws `Error` with a usage message.

  And for a `formatDeviceTable(devices: AuthDevice[]): string` that renders the columns `NAME  FINGERPRINT  PAIRED  LAST SEEN  ADDRESS` (fingerprint shown as first 8 hex chars; `LAST SEEN`/`ADDRESS` show `-` when null). Assert the header row and that a device's label + 8-char fingerprint appear.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement** `parseDeviceArgs`, `formatDeviceTable`, and a `runDevice(args, deps)` runner where `deps` defaults to the real `deviceRegistry` functions but is injectable for tests (pass a fake registry). `runDevice` for `list` prints `formatDeviceTable(listDevices())`; for `revoke` calls `revokeDevice(target)` and prints `Revoked <label> (<fp8>).`; for `rename` calls `renameDevice(target, label)` and prints `Renamed to <label>.`. Catch `RegistryError` and print a friendly one-line message + set a non-zero exit intent (return a status the caller can use; do not call `process.exit` inside the runner — return `{ ok: boolean }` and let `main.ts` decide).

- [ ] **Step 4: Write a runner test** with a fake registry (in-memory array) verifying: `list` output contains the table header; `revoke` on an unknown target prints a not-found message and returns `{ ok: false }`; a successful `rename` returns `{ ok: true }`.

- [ ] **Step 5: Run to confirm pass.** `bun --cwd apps/server test deviceCli` → PASS.

- [ ] **Step 6: Commit.** `git commit -am "feat(devices): device management CLI (list/revoke/rename)"`

---

## Task 4: Wire `devices` / `device` into `main.ts`

**Files:**
- Modify: `apps/server/src/server/main.ts`

- [ ] **Step 1: Add dispatch cases.** In the `switch (cmd)` block, mirroring the `present` case, add:

```ts
  case 'devices': {
    const { runDevice } = await import('./deviceCli');
    const result = runDevice({ kind: 'list' });
    process.exit(result.ok ? 0 : 1);
    break;
  }
  case 'device': {
    const { parseDeviceArgs, runDevice } = await import('./deviceCli');
    try {
      const result = runDevice(parseDeviceArgs(process.argv.slice(3)));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }
```

  Ensure `runMigrations()` has run before the registry is queried — check how the daemon path does it and call it (or a DB init) at the top of these cases if the CLI path does not already. Follow whatever `set-password` / other DB-touching CLI cases do.

- [ ] **Step 2: Add `--help` lines** next to the existing command help text (near the `set-password` help line) for:
  - `devices          List authorized devices`
  - `device <cmd>     Manage a device: revoke <target> | rename <target> <name>`

- [ ] **Step 3: Manual smoke check.** Build is not required; run via source: from `apps/server`, `bun run src/server/main.ts devices` should print the (empty) table header without throwing. (It uses the real DB at `~/.tether` or `TETHER_DB_PATH`; set `TETHER_DB_PATH=/tmp/tether-smoke.db` for the smoke run so you don't touch real data.)

- [ ] **Step 4: Typecheck + lint.** `bun --cwd apps/server run typecheck` and `bunx biome check apps/server/src/server/deviceRegistry.ts apps/server/src/server/deviceCli.ts apps/server/src/server/main.ts` → clean. Fix findings.

- [ ] **Step 5: Commit.** `git commit -am "feat(devices): wire devices/device verbs into the CLI"`

---

## Self-Review (run before reporting done)

- Every `deviceRegistry.ts` export matches the interface block above — names, params, return types, `RegistryError` codes. A sibling plan imports these verbatim; a mismatch breaks it.
- Full server suite still green: `bun --cwd apps/server run test`.
- Typecheck + biome clean on all new/changed files.
- Migration is version 9, appended, not editing an existing one.
- No WebSocket, crypto, or pairing code crept in — this slice is registry + CLI only.

## Report back

Output a summary under ~200 words: files created/changed, the final pass/fail of `bun --cwd apps/server run test`, typecheck, and biome, and any deviations from this plan.
