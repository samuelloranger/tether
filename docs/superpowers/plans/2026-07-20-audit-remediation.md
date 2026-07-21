# Tether Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect from the 2026-07-20 global audit — 5 High, 8 Medium, 14 Low/Info — across the Bun/Hono server, the Expo/RN mobile client, and project CI/supply-chain, without altering behavior operators rely on.

**Architecture:** Work in severity/area phases. Phase 0 wires `bun test` into CI first so every later test actually gates. Phases 1–2 harden the server (auth, IPC, self-update, process lifecycle, client-exit signalling). Phase 3 fixes the mobile client (auth-reconnect storm is the only user-facing bug). Phase 4 tightens supply-chain and config hygiene. Network exposure (ports/TLS/bind) is out of scope by design.

**Tech Stack:** Bun 1.3.14+, Hono, `bun:sqlite`, `bun:test`, TypeScript, Expo 57 / RN 0.86 / React 19, Biome, GitHub Actions.

## Global Constraints

- Runtime floor is **Bun ≥ 1.3.14** (PTY `terminal` API). Do not use APIs newer than the pinned Bun.
- SQLite schema changes go **only** through a new appended entry in the `migrations` array in `apps/server/src/server/db.ts`. Never edit an applied migration. `bun:sqlite` uses `$name` named params.
- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before every commit.
- Tests use `bun:test` (`import { test, expect, describe } from 'bun:test'`), file suffix `*.test.ts`, colocated beside source.
- Server tests that touch the DB set `TETHER_DB_PATH` to a temp path.
- No commit message may include a `Co-Authored-By` trailer.
- "Exposing the port / lack of TLS / run-behind-a-tunnel" is **not** a defect and gets no task.
- Mobile: consult `https://docs.expo.dev/versions/v57.0.0/` before writing Expo code.

---

## File Structure

**Server (`apps/server/src/server/`)**
- `db.ts` — add `setAuthHashIfUnset()`; add migration dropping the redundant index.
- `app.ts` — atomic setup route, Origin/Host guard on setup, WS `msg.text` type-check, `hasControlToken` byte-length guard, exit-during-init check.
- `pty.ts` — `killSession` broadcasts `exit`; holder-close handler broadcasts `exit`; `insertCounts` cleanup on exit path; per-server session cap.
- `holder.ts` — listen-before/guard-around spawn (no orphan PTY); pidfile at listen time; `killPty` SIGSTOP-rescan sweep.
- `main.ts` — PID identity verification in `alive`/`stop`; O_EXCL start guard.
- `update.ts` — SHA-256 verification of the downloaded binary before chmod/exec.
- `procIdentity.ts` *(new)* — `processStartTime(pid)` helper reading `/proc/<pid>/stat` field 22 (Linux) with a darwin `ps` fallback.

**Mobile (`apps/mobile/src/`)**
- `wsTransport.ts` — surface close code / auth rejection to `onClose`.
- `useTetherApp.tsx` — hold `auth-failed` from the WS path, backoff+jitter, keepalive, id-less-output guard, clear `scheduleRender` timer on unmount.
- `terminal.ts` — cap `oscBuf`/`params`/`intermediate`.
- `sessionCache.ts` — `peek()` (non-touching read) + `Math.max(1, cap)`.

**CI / config (repo root)**
- `.github/workflows/ci.yml` — run `bun test` per app; pin actions to SHAs.
- `.github/workflows/release.yml` — `--frozen-lockfile`; publish SHA-256 checksums for server binaries; pin actions.
- `install.sh` — verify checksum before install.
- `apps/server/package.json`, `apps/mobile/package.json`, `tsconfig.json`, `biome.json` — version/strictness/lint unification.

---

## PHASE 0 — CI foundation

### Task 1: Run the whole test suite in CI

**Files:**
- Modify: `.github/workflows/ci.yml:24-33`
- Modify: `apps/server/package.json` (add `test` script)
- Modify: `apps/mobile/package.json` (confirm/normalize `test` script)

**Interfaces:**
- Produces: a `bun test` gate both apps rely on so all later tasks' tests actually run in CI.

- [ ] **Step 1: Add a `test` script to the server package**

In `apps/server/package.json` `scripts`, add:
```json
"test": "bun test"
```

- [ ] **Step 2: Confirm the mobile `test` script runs the whole suite**

In `apps/mobile/package.json`, ensure `scripts.test` is:
```json
"test": "bun test"
```
(Replace any single-file invocation.)

- [ ] **Step 3: Replace the hardcoded CI test steps**

In `.github/workflows/ci.yml`, replace the two test steps with:
```yaml
      - name: Server tests
        run: bun test
        working-directory: apps/server
        env:
          TETHER_DB_PATH: /tmp/tether-ci.db

      - name: Mobile tests
        run: bun test
        working-directory: apps/mobile
```

- [ ] **Step 4: Run the full suite locally to catch pre-existing failures**

Run: `bun --cwd apps/server test && bun --cwd apps/mobile test`
Expected: all suites discovered and run. If any fail today, note them — they are pre-existing and tracked separately, not introduced here.

- [ ] **Step 5: Commit**
```bash
git add .github/workflows/ci.yml apps/server/package.json apps/mobile/package.json
git commit -m "ci: run full bun test suite for both apps"
```

---

## PHASE 1 — Server security

### Task 2: Atomic TOFU password set (HIGH)

**Files:**
- Modify: `apps/server/src/server/db.ts` (after `setAuthHash`, ~line 249)
- Modify: `apps/server/src/server/app.ts:130-137`
- Test: `apps/server/src/server/db.test.ts`

**Interfaces:**
- Produces: `setAuthHashIfUnset(hash: string): boolean` — atomically stores `hash` only if no auth hash exists; returns `true` if it wrote, `false` if one already existed.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/server/db.test.ts`:
```ts
import { setAuthHashIfUnset, setAuthHash, getAuthHash } from './db';

test('setAuthHashIfUnset writes only when unset', () => {
  setAuthHash(null);
  expect(setAuthHashIfUnset('hash-a')).toBe(true);
  expect(getAuthHash()).toBe('hash-a');
  expect(setAuthHashIfUnset('hash-b')).toBe(false);
  expect(getAuthHash()).toBe('hash-a');
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun --cwd apps/server test src/server/db.test.ts`
Expected: FAIL — `setAuthHashIfUnset is not a function`.

- [ ] **Step 3: Implement the atomic setter**

In `db.ts`, after `setAuthHash`:
```ts
// Atomic first-run claim: INSERT ... DO NOTHING is a single statement, so two
// concurrent /api/setup requests can't both pass a null-check and both write.
export function setAuthHashIfUnset(hash: string): boolean {
  const res = db
    .query('INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO NOTHING')
    .run({ $key: AUTH_HASH_KEY, $value: hash });
  return res.changes === 1;
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun --cwd apps/server test src/server/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the setup route**

In `app.ts`, replace the body of `app.post('/api/setup', ...)`:
```ts
app.post('/api/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 1) return c.json({ error: 'empty' }, 400);
  // Hash first, then attempt the atomic claim; if we lost the race the insert
  // does nothing and we report already_setup — no check-then-write window.
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
  if (!setAuthHashIfUnset(hash)) return c.json({ error: 'already_setup' }, 409);
  return c.json({ ok: true });
});
```
Update the import at the top of `app.ts` to include `setAuthHashIfUnset` (replace the `setAuthHash` import if `setAuthHash` is no longer used in `app.ts`; keep `getAuthHash`).

- [ ] **Step 6: Typecheck + format + full server tests**

Run: `bun --cwd apps/server typecheck && bun format && bun --cwd apps/server test`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/server/src/server/db.ts apps/server/src/server/app.ts apps/server/src/server/db.test.ts
git commit -m "fix(server): make TOFU password setup atomic (close check-and-set race)"
```

---

### Task 3: Restrict first-run setup to loopback / same-origin (HIGH)

**Files:**
- Modify: `apps/server/src/server/app.ts` (`/api/setup` and `/api/status`)
- Test: `apps/server/src/server/app.setup.test.ts` (create)

**Interfaces:**
- Consumes: `setAuthHashIfUnset` (Task 2).
- Produces: `/api/setup` rejects requests carrying a cross-origin `Origin` header or a non-loopback `Host`, blocking browser drive-by password claims. Native clients (RN/Tauri) send no browser `Origin` and connect by the operator's chosen host, so they still work.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server/app.setup.test.ts`:
```ts
import { test, expect, beforeEach } from 'bun:test';
import app from './app';
import { setAuthHash } from './db';

beforeEach(() => setAuthHash(null));

test('setup rejects a cross-site Origin', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: '127.0.0.1:8085' },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(403);
});

test('setup allows a same-origin loopback request', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8085', Host: '127.0.0.1:8085' },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(200);
});

test('setup allows a native client (no Origin header)', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: '192.168.1.50:8085' },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(200);
});
```
> Note: `app.ts` currently declares `const app = new Hono()` without exporting it. Add `export default app;` at the end of `app.ts` if not already present, so tests can use `app.request(...)`.

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun --cwd apps/server test src/server/app.setup.test.ts`
Expected: FAIL — cross-site request returns 200 (or 404 if `app` isn't exported yet).

- [ ] **Step 3: Add the origin guard**

In `app.ts`, above the routes add a helper:
```ts
// A browser attaches an Origin header; a native RN/Tauri client does not. When
// an Origin is present we require it to match the Host we were reached on, so a
// random web page can't script the unauthenticated first-run setup on the LAN.
function setupOriginOk(c: { req: { header(name: string): string | undefined } }): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true; // native client — no browser same-origin concept
  const host = c.req.header('Host');
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
```
Then as the first line inside the `/api/setup` handler (before reading the body):
```ts
  if (!setupOriginOk(c)) return c.json({ error: 'forbidden_origin' }, 403);
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun --cwd apps/server test src/server/app.setup.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Typecheck + format + commit**
```bash
bun --cwd apps/server typecheck && bun format
git add apps/server/src/server/app.ts apps/server/src/server/app.setup.test.ts
git commit -m "fix(server): reject cross-origin first-run setup (block browser drive-by)"
```

---

### Task 4: Verify self-update binary by SHA-256 (MED)

**Files:**
- Modify: `apps/server/src/server/update.ts`
- Modify: `.github/workflows/release.yml` (publish `SHA256SUMS.txt` alongside server binaries)
- Test: `apps/server/src/server/update.test.ts`

**Interfaces:**
- Produces: `runUpdate` downloads and verifies a published SHA-256 for the asset before `chmod`/exec; a hash mismatch aborts without ever executing the payload.

- [ ] **Step 1: Publish checksums in release CI**

In `.github/workflows/release.yml`, in the job that builds the four `tether-{linux,darwin}-{x64,arm64}` server binaries, after they are built and before upload, add a step that writes `SHA256SUMS.txt`:
```yaml
      - name: Checksum server binaries
        run: |
          cd <dir-containing-the-tether-* binaries>
          sha256sum tether-* > SHA256SUMS.txt
```
Add `SHA256SUMS.txt` to the release asset upload list for that job.

- [ ] **Step 2: Write the failing test**

Add to `apps/server/src/server/update.test.ts` (create if absent) a test that the verifier rejects a byte buffer whose digest doesn't match, and accepts one that does:
```ts
import { test, expect } from 'bun:test';
import { verifyDigest } from './update';

test('verifyDigest accepts a matching sha256', async () => {
  const bytes = new TextEncoder().encode('hello');
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  expect(await verifyDigest(bytes, digest)).toBe(true);
});

test('verifyDigest rejects a mismatch', async () => {
  const bytes = new TextEncoder().encode('hello');
  expect(await verifyDigest(bytes, 'deadbeef')).toBe(false);
});
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `bun --cwd apps/server test src/server/update.test.ts`
Expected: FAIL — `verifyDigest is not a function`.

- [ ] **Step 4: Implement `verifyDigest` and wire it in**

In `update.ts`, add:
```ts
// Compare the downloaded bytes against the expected hex sha256. Case-insensitive.
export function verifyDigest(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return actual.toLowerCase() === expectedHex.trim().toLowerCase();
}
```
In `runUpdate`, after resolving the release assets: fetch `SHA256SUMS.txt` from the release, parse the line for the asset filename to get `expectedHex`, download the binary bytes, and gate on the digest **before** writing/chmod/exec:
```ts
  const sumsText = await fetchText(sha256sumsUrl); // browser_download_url of SHA256SUMS.txt
  const expected = sumsText
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === assetName)?.[0];
  if (!expected) throw new Error('no published checksum for ' + assetName);

  const bytes = new Uint8Array(await (await fetch(downloadUrl)).arrayBuffer());
  if (!verifyDigest(bytes, expected)) throw new Error('update checksum mismatch — aborting');

  // only now write to tmp, chmod, atomic rename. Do NOT execute the binary as a
  // verification step — the checksum is the trust decision.
```
Remove the `Bun.spawnSync([tmp, 'version'])` "sanity check" that executed the untrusted binary.

- [ ] **Step 5: Run test, expect PASS; typecheck**

Run: `bun --cwd apps/server test src/server/update.test.ts && bun --cwd apps/server typecheck`
Expected: PASS.

- [ ] **Step 6: Format + commit**
```bash
bun format
git add apps/server/src/server/update.ts apps/server/src/server/update.test.ts .github/workflows/release.yml
git commit -m "fix(server): verify self-update binary by sha256 before exec"
```

---

### Task 5: Lock down holder socket & config dir permissions (MED)

**Files:**
- Modify: `apps/server/src/server/pty.ts:90-91` (HOLDERS_DIR creation)
- Modify: `apps/server/src/server/holder.ts` (chmod socket + pidfile)
- Modify: `apps/server/src/server/db.ts` / `paths.ts` (config dir mode where the DB lives)

**Interfaces:**
- Produces: `HOLDERS_DIR`, the config dir, the unix socket, and `.sock.pid` are created mode `0700`/`0600` so other local users can't traverse to or connect to the IPC channel or read the argon2 hash.

- [ ] **Step 1: Create HOLDERS_DIR restricted**

In `pty.ts` where `mkdirSync(HOLDERS_DIR, { recursive: true })` is called, add the mode:
```ts
mkdirSync(HOLDERS_DIR, { recursive: true, mode: 0o700 });
```

- [ ] **Step 2: Restrict the config dir that holds the DB**

Wherever the config/state dir is created (see `paths.ts` / first DB open in `db.ts`), pass `{ recursive: true, mode: 0o700 }` to its `mkdirSync`. If the dir may already exist with looser perms, add a `chmodSync(dir, 0o700)` after ensuring it exists.

- [ ] **Step 3: chmod the socket and pidfile in the holder**

In `holder.ts`, immediately after `Bun.listen({ unix: socketPath, ... })` returns, and after `writeFileSync(\`${socketPath}.pid\`, ...)`, add:
```ts
  try {
    chmodSync(socketPath, 0o600);
    chmodSync(`${socketPath}.pid`, 0o600);
  } catch {}
```
Add `chmodSync` to the `node:fs` import in `holder.ts`.

- [ ] **Step 4: Manual verification**

Run: `bun dev:server` in one shell, start a session from a client, then:
`stat -c '%a %n' ~/.tether/config ~/.tether/config/holders ~/.tether/config/holders/*.sock`
Expected: `700` on the dirs, `600` on the socket.

- [ ] **Step 5: Format + commit**
```bash
bun format
git add apps/server/src/server/pty.ts apps/server/src/server/holder.ts apps/server/src/server/paths.ts apps/server/src/server/db.ts
git commit -m "fix(server): restrict holder socket + config dir to owner (0700/0600)"
```

---

### Task 6: Harden WS input, session cap, control-token compare (LOW)

**Files:**
- Modify: `apps/server/src/server/app.ts` (`onMessage`, `hasControlToken`, session start)
- Modify: `apps/server/src/server/pty.ts` (session cap constant + guard)
- Test: `apps/server/src/server/app.token.test.ts` (create)

**Interfaces:**
- Produces: `writeToSession` is only called with a string; `hasControlToken` never throws on byte-length mismatch; a per-server active-session cap rejects unbounded spawns.

- [ ] **Step 1: Write the failing test for the token guard**

Create `apps/server/src/server/app.token.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { hasControlToken } from './app';

test('hasControlToken returns false (no throw) for multibyte same-length input', () => {
  // Same string length as a hex token but different byte length must not throw.
  expect(() => hasControlToken('é'.repeat(64))).not.toThrow();
  expect(hasControlToken('é'.repeat(64))).toBe(false);
});
```
> Export `hasControlToken` from `app.ts` (`export function hasControlToken`).

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun --cwd apps/server test src/server/app.token.test.ts`
Expected: FAIL — throws (byte length ≠ string length) or not exported.

- [ ] **Step 3: Fix `hasControlToken` to compare byte lengths**
```ts
export function hasControlToken(value: string | undefined): boolean {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(presentationControlToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Type-check WS `msg.text`**

In `app.ts` `onMessage`, change the input branch:
```ts
          if (msg.type === 'input' && typeof msg.text === 'string') {
            writeToSession(sessionId, msg.text);
          } else if (msg.type === 'resize') {
```

- [ ] **Step 5: Add a session cap in `pty.ts`**

Near the top of `pty.ts`:
```ts
const MAX_SESSIONS = Number(process.env.TETHER_MAX_SESSIONS || 50);
```
In `startSession`, before spawning a brand-new holder (i.e. when the id has no instance and no pending start), add:
```ts
  if (!instances.has(id) && instances.size >= MAX_SESSIONS) {
    throw new Error(`session cap reached (${MAX_SESSIONS})`);
  }
```

- [ ] **Step 6: Run test + typecheck, expect PASS**

Run: `bun --cwd apps/server test src/server/app.token.test.ts && bun --cwd apps/server typecheck`
Expected: PASS.

- [ ] **Step 7: Format + commit**
```bash
bun format
git add apps/server/src/server/app.ts apps/server/src/server/pty.ts apps/server/src/server/app.token.test.ts
git commit -m "fix(server): validate WS input type, cap sessions, guard token compare"
```

---

## PHASE 2 — Server reliability

### Task 7: No orphaned PTY when the holder's listen fails (HIGH)

**Files:**
- Modify: `apps/server/src/server/holder.ts:70-158`

**Interfaces:**
- Produces: if `Bun.listen` throws after the shell is spawned, the shell is SIGKILLed before the holder exits — no ownerless PTY.

- [ ] **Step 1: Wrap spawn+listen so a listen failure kills the shell**

In `holder.ts`, wrap the `Bun.listen(...)` call in try/catch and, on failure, kill the already-spawned `proc` before rethrowing:
```ts
  let server;
  try {
    server = Bun.listen({ unix: socketPath, socket: { /* existing handlers */ } });
  } catch (err) {
    // The shell is already spawned; without a socket nobody can ever own or
    // kill it. Take it down with us rather than leaking an orphan PTY.
    try {
      proc.kill('SIGKILL');
    } catch {}
    throw err;
  }
```

- [ ] **Step 2: Manual verification**

Reproduce a listen failure by pre-creating a directory at the socket path so `Bun.listen` fails:
```bash
mkdir -p ~/.tether/config/holders/orphan-test.sock
# start a session with id "orphan-test" via the client/API, observe the holder exits
ps -ef | grep -c '[b]ash'   # confirm no leftover shell from the failed holder
rmdir ~/.tether/config/holders/orphan-test.sock
```
Expected: no orphaned shell survives the failed holder start.

- [ ] **Step 3: Format + commit**
```bash
bun format
git add apps/server/src/server/holder.ts
git commit -m "fix(server): kill spawned shell if holder listen fails (no orphan PTY)"
```

---

### Task 8: Verify process identity before signalling (HIGH)

**Files:**
- Create: `apps/server/src/server/procIdentity.ts`
- Modify: `apps/server/src/server/main.ts` (`alive`, `start` writes identity, `stop`/`status` verify)
- Test: `apps/server/src/server/procIdentity.test.ts`

**Interfaces:**
- Produces: `processStartTime(pid: number): string | null` — a stable per-process identity token (Linux `/proc/<pid>/stat` field 22; darwin `ps -o lstart=`). `start` records `pid:startTime` in the PID file; `alive`/`stop` only signal when the recorded start time still matches, so a recycled PID is never killed.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server/procIdentity.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { processStartTime } from './procIdentity';

test('processStartTime returns a stable non-null value for our own pid', () => {
  const a = processStartTime(process.pid);
  const b = processStartTime(process.pid);
  expect(a).not.toBeNull();
  expect(a).toBe(b);
});

test('processStartTime returns null for an impossible pid', () => {
  expect(processStartTime(2 ** 31 - 1)).toBeNull();
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun --cwd apps/server test src/server/procIdentity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `procIdentity.ts`**
```ts
import { readFileSync } from 'node:fs';

// A per-process identity token that changes if the PID is recycled. On Linux we
// read starttime (field 22 of /proc/<pid>/stat, in clock ticks since boot). On
// other platforms we fall back to `ps` lstart. Returns null if the pid is gone.
export function processStartTime(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; split after the last ')'.
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // fields from field 3 onward; starttime is field 22 => index 22 - 3 = 19.
      const starttime = after[19];
      return starttime ?? null;
    } catch {
      return null;
    }
  }
  try {
    const out = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)]).stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun --cwd apps/server test src/server/procIdentity.test.ts`
Expected: PASS.

- [ ] **Step 5: Record identity on start, verify before signalling**

In `main.ts`:
- Import: `import { processStartTime } from './procIdentity';`
- In `start`, change the PID file write to include the identity token:
```ts
  const token = processStartTime(child.pid) ?? '';
  writeFileSync(PID_FILE, `${child.pid} ${token}`);
```
- Replace `runningPid` to parse and verify the token:
```ts
function runningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const [pidStr, token = ''] = readFileSync(PID_FILE, 'utf8').trim().split(' ');
  const pid = Number(pidStr);
  if (!pid || !alive(pid)) return null;
  // A recycled PID won't have the same start time we recorded — treat as dead.
  if (token && processStartTime(pid) !== token) return null;
  return pid;
}
```
(`stop`/`status` already go through `runningPid`, so they inherit the identity check.)

- [ ] **Step 6: Typecheck + full server tests + format**

Run: `bun --cwd apps/server typecheck && bun --cwd apps/server test && bun format`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/server/src/server/procIdentity.ts apps/server/src/server/main.ts apps/server/src/server/procIdentity.test.ts
git commit -m "fix(server): verify process start-time before kill (no PID-reuse kill)"
```

---

### Task 9: Always tell clients when a session ends (MED)

**Files:**
- Modify: `apps/server/src/server/pty.ts` (`killSession` ~492, holder-close handler ~262)
- Modify: `apps/server/src/server/app.ts` (exit-during-WS-init ~360)

**Interfaces:**
- Consumes: existing `broadcast(id, { type: 'exit', ... })` and `instance.subscribers`.
- Produces: an `exit` frame reaches subscribers on explicit kill, on unexpected holder-close, and when a session is already gone at subscribe time.

- [ ] **Step 1: Broadcast exit on explicit kill**

In `pty.ts` `killSession`, before `instances.delete(id)`:
```ts
  if (instance) {
    instance.gitWatch.dispose();
    for (const sub of instance.subscribers) {
      try {
        sub({ type: 'exit', exitCode: null });
      } catch {}
    }
    instance.subscribers.clear();
    instances.delete(id);
  }
```

- [ ] **Step 2: Broadcast exit on unexpected holder-close**

In `pty.ts` the socket `close()` handler, before/at `instances.delete(id)`:
```ts
        close() {
          const instance = instances.get(id);
          if (!exited && instance?.sock) {
            for (const sub of instance.subscribers) {
              try {
                sub({ type: 'exit', exitCode: null });
              } catch {}
            }
            instance.subscribers.clear();
            if (instances.delete(id)) {
              instance.gitWatch.dispose();
              clearLiveCwd(id);
              console.log(`Holder link for session "${id}" closed unexpectedly`);
            }
          }
        },
```

- [ ] **Step 3: Emit exit if the session died during WS init**

In `app.ts`, inside the deferred `setTimeout`, after `unsubscribe = subscribeToSession(...)`:
```ts
            if (closed) return;
            unsubscribe = subscribeToSession(sessionId, onData, cols, rows);
            // If the session already exited during the awaits above, subscribe
            // returned the no-op and no exit will ever arrive — tell the client now.
            if (!getActiveSession(sessionId)) {
              ws.send(JSON.stringify({ type: 'exit', exitCode: null }));
            }
```
(`getActiveSession` is already exported from `pty.ts`; add it to the import in `app.ts` if missing.)

- [ ] **Step 4: Manual verification**

Run `bun dev:server`, attach a client, then (a) kill the session via `POST /api/sessions/kill`, (b) `kill -9` a holder process directly. In both the client should receive an `exit` and stop showing the terminal as live.

- [ ] **Step 5: Typecheck + format + commit**
```bash
bun --cwd apps/server typecheck && bun format
git add apps/server/src/server/pty.ts apps/server/src/server/app.ts
git commit -m "fix(server): broadcast exit to clients on kill, holder-close, and init-race"
```

---

### Task 10: Make the kill sweep catch racing children (MED)

**Files:**
- Modify: `apps/server/src/server/holder.ts` (`killPty`, `pidsInSession`)

**Interfaces:**
- Produces: `killPty` stops the session, re-scans, then kills — so a child forked during the sweep window is still caught. (setsid-detached daemons remain out of reach by design; document that.)

- [ ] **Step 1: SIGSTOP → rescan → SIGKILL**

In `holder.ts` `killPty`, replace the single-pass sweep with a stop-then-sweep:
```ts
  function killPty() {
    const sid = getSid(proc.pid) ?? proc.pid;
    // Freeze the process group first so nothing new forks out from under the
    // scan, then enumerate and kill. A child that setsid's into its own session
    // is intentionally out of scope (that's how real daemons detach).
    for (const pid of pidsInSession(sid)) {
      if (pid === proc.pid) continue;
      try {
        process.kill(pid, 'SIGSTOP');
      } catch {}
    }
    for (const pid of pidsInSession(sid)) {
      if (pid === proc.pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    proc.kill('SIGHUP');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, 1000);
  }
```

- [ ] **Step 2: Manual verification (reproduces the recorded orphan bug)**

In a tether session shell:
```bash
sleep 9999 &
nohup sleep 9998 &
disown
```
Then kill the session from the client. Confirm both `sleep` PIDs are gone:
`pgrep -a sleep | grep 999`
Expected: no matches for the plain and nohup+disown jobs.

- [ ] **Step 3: Format + commit**
```bash
bun format
git add apps/server/src/server/holder.ts
git commit -m "fix(server): freeze session before sweep so racing children can't escape kill"
```

---

### Task 11: Lifecycle & SQLite housekeeping (LOW)

**Files:**
- Modify: `apps/server/src/server/holder.ts` (pidfile at listen time)
- Modify: `apps/server/src/server/pty.ts` (delete `insertCounts` entry on exit path)
- Modify: `apps/server/src/server/db.ts` (migration dropping redundant index; `deleteInsertCount` helper)
- Modify: `apps/server/src/server/main.ts` (O_EXCL start guard)

**Interfaces:**
- Consumes: `insertCounts` map in `db.ts`.
- Produces: `clearInsertCount(id: string): void`; a migration that drops `idx_terminal_logs_session`; pidfile written before the socket accepts; `start` cannot double-spawn.

- [ ] **Step 1: Write the pidfile before listening**

In `holder.ts`, move `writeFileSync(\`${socketPath}.pid\`, String(process.pid));` to immediately **before** the `Bun.listen(...)` call (so the file exists the instant the socket can accept). Keep the `chmodSync` from Task 5 right after it.

- [ ] **Step 2: Clear the insert counter when a session ends via the holder exit path**

In `db.ts`, add near the other settings helpers:
```ts
export function clearInsertCount(id: string): void {
  insertCounts.delete(id);
}
```
In `pty.ts`, in the branch that handles the holder `x` (exit) frame (~lines 210-224), call `clearInsertCount(id)` when the session is torn down there.

- [ ] **Step 3: Add a migration dropping the redundant index**

Append a new entry to the `migrations` array in `db.ts` (do not edit existing ones):
```ts
  {
    version: <next-int>,
    name: 'drop-redundant-session-index',
    up: (db) => {
      // Fully covered by the composite idx_terminal_logs_session_id(session_id, id);
      // the single-column index only added write cost on the hot insert path.
      db.run('DROP INDEX IF EXISTS idx_terminal_logs_session');
    },
  },
```

- [ ] **Step 4: Guard against double-spawn on start**

In `main.ts` `start`, write the PID file with `openSync(PID_FILE, 'wx')` (O_EXCL) semantics, or acquire a lock before spawning: if the exclusive create fails because the file exists and `runningPid()` is non-null, log "already running" and return; if the file exists but `runningPid()` is null (stale), `rmSync` it and retry once.

- [ ] **Step 5: Typecheck + full server tests + format**

Run: `bun --cwd apps/server typecheck && bun --cwd apps/server test && bun format`
Expected: PASS (migration applies idempotently; `db.test.ts` still green).

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/server/holder.ts apps/server/src/server/pty.ts apps/server/src/server/db.ts apps/server/src/server/main.ts
git commit -m "fix(server): pidfile-before-listen, insert-count cleanup, drop dup index, start guard"
```

---

## PHASE 3 — Mobile client

### Task 12: Stop the wrong-password reconnect storm (HIGH)

**Files:**
- Modify: `apps/mobile/src/wsTransport.ts` (surface close code)
- Modify: `apps/mobile/src/useTetherApp.tsx:395-436` (`connect` `onClose`)

**Interfaces:**
- Consumes: `openTerminalSocket(url, password, handlers)`.
- Produces: `onClose` receives `{ code?: number, authFailed?: boolean }`; when auth failed, `connect` sets `connectionStatus` to `auth-failed` and does **not** schedule a reconnect until the user changes the password.

- [ ] **Step 1: Surface the close code / auth signal from the transport**

In `wsTransport.ts`, change the `onClose` handler signature so it forwards whether the close looks like an auth rejection. For RN WebSocket, `onclose` provides `code`; the server rejects the upgrade with HTTP 401, which surfaces as a close without ever opening. Detect "closed before it ever opened" as the auth signal:
```ts
  let everOpen = false;
  ws.onopen = () => { everOpen = true; handlers.onOpen?.(); };
  ws.onclose = (e: { code?: number }) => {
    handlers.onClose?.({ code: e?.code, authFailed: !everOpen });
  };
```
Update the `onClose` type in the handlers interface to `onClose?: (info: { code?: number; authFailed?: boolean }) => void`. For the Tauri path, map a rejected connect/`ws_send` the same way (`authFailed: !everOpen`).

- [ ] **Step 2: Hold auth-failed and stop reconnecting in `connect`**

In `useTetherApp.tsx`, replace the `onClose` handler in `connect`:
```ts
      onClose: (info) => {
        if (!fresh()) return;
        st.open = false;
        if (info?.authFailed) {
          // Bad password: surface it and STOP. Reconnecting every 3s would
          // hammer the server forever and never succeed until the user acts.
          if (id === activeIdRef.current) setConnectionStatus('auth-failed');
          st.retry = 0;
          return;
        }
        if (id === activeIdRef.current) setConnectionStatus('disconnected');
        if (readyRef.current && cache.has(id)) {
          const delay = backoffDelay(st.retry++);
          st.reconnectTimeout = setTimeout(() => connect(id), delay);
        }
      },
```
Add a `retry: number` field to the per-connection state object (initialize `retry: 0` where `gen`/`open` are initialized, ~line 213) and reset `st.retry = 0` in `onOpen`.

- [ ] **Step 3: Add backoff with jitter (covers the LOW backoff finding too)**

Near the other helpers in `useTetherApp.tsx`:
```ts
// Exponential backoff, capped, with jitter — so N tabs don't retry in lockstep
// and a downed server isn't hit at a steady 1 req/s per tab.
function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return base / 2 + Math.floor(Math.random() * (base / 2));
}
```

- [ ] **Step 4: When the user re-enters a password, clear auth-failed and reconnect**

In `saveConfig` (where address/password changes are applied, ~line 859), after applying new creds, reset each connection's `retry` to 0 and reconnect the active tab — the existing `disconnectAll()` + active reconnect path already does this; ensure `retry` is zeroed so backoff starts fresh.

- [ ] **Step 5: Manual verification**

Run `bun dev:mobile`, connect with a wrong password. Expected: status settles on "Auth" (not oscillating "Reconnecting…"), and network traffic stops (no 3s retry loop). Fix the password → reconnects and works.

- [ ] **Step 6: Typecheck + commit**
```bash
bun --cwd apps/mobile lint
git add apps/mobile/src/wsTransport.ts apps/mobile/src/useTetherApp.tsx
git commit -m "fix(mobile): stop reconnect storm on auth failure; add backoff+jitter"
```

---

### Task 13: Cap VT parser escape buffers (MED)

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (osc/csi accumulation, ~lines 371, 475-479)
- Test: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Produces: `oscBuf`, `params`, `intermediate` never exceed a cap; on overflow the parser resets to `ground` and discards the runaway sequence.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/terminal.test.ts`:
```ts
test('unterminated OSC does not grow the parser buffer without bound', () => {
  const term = new Terminal(80, 24); // match the actual constructor
  // ESC ] then a megabyte of payload with no terminator.
  term.write('\x1b]0;' + 'A'.repeat(1_000_000));
  // Buffer must be capped, and the terminal must still accept normal output after reset.
  term.write('\x1b\\hello');
  expect(term.getScreenText().includes('hello')).toBe(true);
});
```
> Adjust `new Terminal(...)` and the text-read method to the real API in `terminal.ts`.

- [ ] **Step 2: Run it, expect FAIL (or slow/OOM)**

Run: `bun --cwd apps/mobile test src/terminal.test.ts`
Expected: FAIL / excessive memory.

- [ ] **Step 3: Add the cap**

Near the top of `terminal.ts`:
```ts
const MAX_SEQ_LEN = 4096; // cap on OSC/CSI accumulation to bound memory on garbled input
```
In the `osc` accumulation branch (`this.oscBuf += ch`):
```ts
          this.oscBuf += ch;
          if (this.oscBuf.length > MAX_SEQ_LEN) {
            this.oscBuf = '';
            this.state = 'ground';
          }
```
In the CSI param/intermediate accumulation (`this.params += ch` / `this.intermediate += ch`):
```ts
      this.params += ch;
      if (this.params.length + this.intermediate.length > MAX_SEQ_LEN) {
        this.params = '';
        this.intermediate = '';
        this.state = 'ground';
      }
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun --cwd apps/mobile test src/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "fix(mobile): cap VT OSC/CSI buffers to bound memory on garbled streams"
```

---

### Task 14: Remove LRU mutation from render (MED)

**Files:**
- Modify: `apps/mobile/src/sessionCache.ts` (add `peek`)
- Modify: `apps/mobile/src/useTetherApp.tsx:1404-1526` (render-body reads)
- Test: `apps/mobile/src/sessionCache.test.ts`

**Interfaces:**
- Produces: `SessionCache.peek(id): Entry | undefined` — returns the entry **without** reordering the LRU or triggering eviction. Render reads use `peek`; `touch` stays in effects/handlers only.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/sessionCache.test.ts`:
```ts
test('peek does not reorder the LRU or evict', () => {
  const evicted: string[] = [];
  const c = new SessionCache(2, (e) => evicted.push(e.id));
  c.touch('a'); c.touch('b');
  c.peek('a');        // must NOT make 'a' most-recent
  c.touch('c');       // over cap -> evicts LRU; if peek reordered, 'b' would go instead of 'a'
  expect(evicted).toEqual(['a']);
});
```
> Match the real `SessionCache` constructor signature.

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun --cwd apps/mobile test src/sessionCache.test.ts`
Expected: FAIL — `peek is not a function`.

- [ ] **Step 3: Implement `peek`**

In `sessionCache.ts`:
```ts
  // Read an entry without touching LRU order — safe to call during render.
  peek(id: string): Entry | undefined {
    return this.map.get(id);
  }
```

- [ ] **Step 4: Use `peek` in the render body**

In `useTetherApp.tsx`, replace `entryFor(activeId)` / `entryFor(id)` calls that occur in render (lines ~1404, 1407, 1410, and inside `renderRow` ~1526) with `cache.peek(...)` (guard for `undefined`). Leave `entryFor` (which touches) in effects and event handlers.

- [ ] **Step 5: Run test + lint, expect PASS**

Run: `bun --cwd apps/mobile test src/sessionCache.test.ts && bun --cwd apps/mobile lint`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/src/sessionCache.ts apps/mobile/src/useTetherApp.tsx apps/mobile/src/sessionCache.test.ts
git commit -m "fix(mobile): read cache via non-touching peek during render"
```

---

### Task 15: Remaining client robustness nits (LOW)

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (id-less output guard ~363, keepalive, scheduleRender cleanup ~328)
- Modify: `apps/mobile/src/sessionCache.ts` (clamp cap)
- Test: `apps/mobile/src/sessionCache.test.ts`

**Interfaces:**
- Produces: id-less output frames are not re-applied during replay; a WS keepalive forces reconnect on a half-open socket; the `scheduleRender` timer is cleared on unmount; `SessionCache` cap is `>= 1`.

- [ ] **Step 1: Clamp the cache cap (write failing test first)**

Add to `sessionCache.test.ts`:
```ts
test('cap is clamped to at least 1', () => {
  const c = new SessionCache(0, () => {});
  c.touch('only');
  expect(c.has('only')).toBe(true); // must not evict the entry it just created
});
```
Then in `sessionCache.ts` constructor store `this.cap = Math.max(1, cap)`.

- [ ] **Step 2: Guard id-less output frames**

In `useTetherApp.tsx` `applyWsMessage`, in the `output` branch, only write when an id is present (matching the existing dedup contract):
```ts
      if (msg.type === 'output') {
        if (typeof msg.id !== 'number') return; // server always sends an id; drop malformed
        if (msg.id <= e.lastAppliedId) return;
        e.lastAppliedId = msg.id;
        e.sinceId = msg.id;
        term.write(msg.chunk);
        if (id === activeIdRef.current) scheduleRender();
      }
```

- [ ] **Step 3: Clear the scheduleRender timer on unmount**

Store the timer id and clear it. Change `scheduleRender` to keep the id:
```ts
  const renderTimer = useRef<any>(null);
  const scheduleRender = () => {
    if (renderScheduled.current) return;
    renderScheduled.current = true;
    renderTimer.current = setTimeout(() => {
      renderScheduled.current = false;
      // ...existing body...
    }, /* existing delay */);
  };
```
In the mount effect's cleanup (the same effect that does `disconnectAll()` on unmount), add:
```ts
    if (renderTimer.current) clearTimeout(renderTimer.current);
```

- [ ] **Step 4: Add a WS keepalive**

In `connect` `onOpen`, start an interval that pings and, if no traffic has been seen within a timeout, forces a reconnect by closing the socket (which triggers the `onClose` backoff path):
```ts
        st.lastSeen = Date.now();
        st.ping = setInterval(() => {
          if (Date.now() - st.lastSeen > 30_000) {
            try { st.sock?.close(); } catch {}
          }
        }, 15_000);
```
Set `st.lastSeen = Date.now()` in `onMessage`, and clear `st.ping` in `disconnect` and in `onClose`. Add `ping` and `lastSeen` to the per-connection state type. (If the server has no ping frame, closing on silence is sufficient; do not add a server protocol change.)

- [ ] **Step 5: Run tests + lint**

Run: `bun --cwd apps/mobile test && bun --cwd apps/mobile lint`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/sessionCache.ts apps/mobile/src/sessionCache.test.ts
git commit -m "fix(mobile): guard id-less output, add ws keepalive, clear render timer, clamp cap"
```

---

## PHASE 4 — Supply chain & config

### Task 16: Supply-chain hardening (MED)

**Files:**
- Modify: `install.sh`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml` (pin actions to SHAs; `--frozen-lockfile`)
- Modify: `.github/workflows/release.yml` (Android keystore — from secrets)

**Interfaces:**
- Consumes: `SHA256SUMS.txt` published by Task 4.
- Produces: `install.sh` verifies the binary's SHA-256 before install; all third-party actions pinned to commit SHAs; release jobs use `--frozen-lockfile`; Android APK signed with a real keystore.

- [ ] **Step 1: Verify checksum in `install.sh`**

After the binary is downloaded to the temp dir and before `chmod +x`/install, fetch `SHA256SUMS.txt` from the same release and verify:
```sh
curl -fsSL "$SUMS_URL" -o "$tmp/SHA256SUMS.txt"
expected=$(grep " $asset_name\$" "$tmp/SHA256SUMS.txt" | awk '{print $1}')
[ -n "$expected" ] || { echo "no published checksum for $asset_name" >&2; exit 1; }
echo "$expected  $tmp/$asset_name" | sha256sum -c - || { echo "checksum mismatch" >&2; exit 1; }
```
(Use `shasum -a 256 -c -` as a fallback when `sha256sum` is absent — macOS.)

- [ ] **Step 2: Pin third-party actions to commit SHAs**

In all three workflow files, replace floating tags with pinned SHAs and a trailing version comment, e.g.:
```yaml
      - uses: oven-sh/setup-bun@<full-sha> # v2
      - uses: tauri-apps/tauri-action@<full-sha> # v0
      - uses: dtolnay/rust-toolchain@<full-sha> # stable
      - uses: maxim-lobanov/setup-xcode@<full-sha> # v1
```
Look up each SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. Also pin `actions/*`. Set `bun-version` to a concrete version rather than `latest`.

- [ ] **Step 3: `--frozen-lockfile` in release jobs**

In `release.yml`, change every `bun install` to `bun install --frozen-lockfile`.

- [ ] **Step 4: Android keystore from secrets**

In `release.yml` android job, replace the RN debug-keystore signing with a real keystore decoded from a repo secret (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`). Decode to a file in the job, point the Gradle signing config at it. If secrets aren't provisioned yet, leave a clearly-commented `# TODO(secrets): provision ANDROID_KEYSTORE_*` and keep the existing behavior — but do not silently ship debug-signed as if it were release-signed.

- [ ] **Step 5: Verify workflows parse**

Run: `gh workflow view CI` locally is not possible offline; instead lint YAML: `bunx yaml-lint .github/workflows/*.yml` (or `python -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`).
Expected: no parse errors.

- [ ] **Step 6: Commit**
```bash
git add install.sh .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "build: verify install checksum, pin actions to SHAs, frozen lockfile in release"
```

---

### Task 17: Config consistency (LOW)

**Files:**
- Modify: `apps/server/package.json`, `apps/mobile/package.json`, root `package.json`
- Modify: `tsconfig.json`, `apps/server/tsconfig.json` / `apps/mobile/tsconfig.json` (if present)
- Modify: `biome.json`

**Interfaces:**
- Produces: one TypeScript version hoisted to root with a `~` range; app tsconfigs `extends` the root; extra strict-family flags on; Biome `recommended: true`; a real mobile lint step; `@types/bun` pinned.

- [ ] **Step 1: Unify TypeScript**

Pick one version (the higher stable both apps tolerate). Move `typescript` to the root `package.json` `devDependencies` with a tilde range (e.g. `~7.0.2` if 7.x is intended, else `~6.0.3`). Remove the per-app `typescript` entries. Run `bun install` and `bun --cwd apps/server typecheck` + `bun --cwd apps/mobile lint` to confirm both still typecheck on the unified version; if 7.x breaks mobile, standardize on the version that builds both and note it.

- [ ] **Step 2: Tighten root tsconfig and have apps extend it**

In `tsconfig.json` `compilerOptions`, add:
```json
"noUncheckedIndexedAccess": true,
"noImplicitOverride": true,
"noFallthroughCasesInSwitch": true
```
Ensure each app tsconfig has `"extends": "../../tsconfig.json"`. Fix any new type errors these flags surface (expect a handful around array/index access in `terminal.ts` and `db.ts`).

- [ ] **Step 3: Explicit Biome recommended + mobile lint**

In `biome.json`, set:
```json
"linter": { "enabled": true, "rules": { "recommended": true } }
```
(keeping the existing `noTemplateCurlyInString: off`). Give `apps/mobile` a real Biome lint step: add `"lint": "biome check . && tsc --noEmit"` (or split into `lint` + `typecheck`) so Biome actually runs on mobile source. Make the root `lint` fan out to both apps' `lint` consistently.

- [ ] **Step 4: Pin `@types/bun`**

In `apps/server/package.json`, replace `"@types/bun": "latest"` with a concrete range matching the installed version (read it from the lockfile).

- [ ] **Step 5: Verify everything builds and lints**

Run: `bun install && bun lint && bun --cwd apps/server test && bun --cwd apps/mobile test`
Expected: PASS across the board.

- [ ] **Step 6: Commit**
```bash
git add package.json apps/server/package.json apps/mobile/package.json tsconfig.json apps/server/tsconfig.json apps/mobile/tsconfig.json biome.json
git commit -m "chore: unify TypeScript, tighten tsconfig/biome, add mobile lint"
```

---

## Self-Review

**Spec coverage** — every audit finding maps to a task:
- HIGH: TOFU race → T2; CORS drive-by → T3; orphan PTY → T7; PID-reuse kill → T8; mobile reconnect storm → T12. ✓
- MED: update integrity → T4; holder socket perms → T5; missing exit frames → T9; killPty race → T10; VT buffer growth → T13; render-time LRU mutation → T14; supply-chain → T16. ✓
- LOW/INFO: WS type/cap/token → T6; pidfile/insertCounts/index/double-spawn → T11; id-less output/backoff/keepalive/timer/cap → T12+T15; config consistency → T17. ✓
- CI (HIGH) → T1. ✓

**Placeholder scan** — infra tasks (T4 checksum publish, T16 keystore) that depend on real release SHAs/secrets carry explicit lookup commands and `TODO(secrets)` markers rather than silent gaps; all code steps include real code.

**Type consistency** — `setAuthHashIfUnset` (T2) reused by T3; `getActiveSession` (existing, used T6/T9); `peek` (T14) reused by T15; `processStartTime` (T8) reused by `runningPid`; `SessionCache` constructor `(cap, onEvict)` consistent across T14/T15; `onClose` handler shape `{code, authFailed}` consistent T12.
