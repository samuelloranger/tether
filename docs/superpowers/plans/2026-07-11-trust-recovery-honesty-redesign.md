# Tether Trust, Recovery & Honesty Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Tether's unauthenticated-shell trust hole with a shared-password auth layer, make first-run connection verifiable and recoverable, and fix the honesty/accessibility/weight gaps the design audit flagged (16/30 → target ≥20/30).

**Architecture:** Server gains a `settings` table holding an argon2 password hash and a Hono middleware that rejects any `/api/*` request lacking a valid `Authorization: Bearer <password>`. The mobile client stores the shared password in `expo-secure-store` and attaches it to every `fetch` and to the WebSocket upgrade via the RN options-arg `headers`. Setup becomes a testable flow (probe `GET /api/health` before saving) with distinct states; copy and destructive-action disclosures are corrected. Encryption is out of scope — delegated to the deployment tunnel and stated honestly in the UI.

**Tech Stack:** Bun + Hono + bun:sqlite (server); Expo RN 57 / React 19 (mobile); `Bun.password` (argon2id); `expo-secure-store`.

## Global Constraints

- Runtime floor: **Bun ≥ 1.3.14** (PTY `terminal` option). Confirmed installed: 1.3.14.
- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` (server) before committing server files.
- SQLite: `$name` named params only. Schema changes append a **new** versioned entry to the `migrations` array in `apps/server/src/server/db.ts` — never edit an applied migration.
- Mobile: read https://docs.expo.dev/versions/v57.0.0/ before writing Expo code. Expo 57 / RN 0.86 / React 19.
- No secret in any URL or log — password travels only in the `Authorization` header.
- Encryption is the tunnel's job. No UI/string may claim the password encrypts traffic.
- Auth scope: protect all `/api/*`. Leave `GET /` unauthenticated (liveness only, no data — the `tether status` CLI probes it).
- Copy strings are exact and verbatim from the spec — do not paraphrase.
- No test runner is configured repo-wide. Server pure logic is tested with `bun test` (native, run from `apps/server`). Mobile pure helpers follow the existing custom `eq`/`pass` pattern run via `bun test` from `apps/mobile` (see `apps/mobile/src/input.test.ts`). RN UI changes end with an explicit manual on-device verification step (no simulator in this environment).

---

## File Structure

**Server (`apps/server/`)**
- `src/server/db.ts` — *modify*: migration #4 (`settings` table) + `getSetting`/`setSetting`/`getAuthHash`/`setAuthHash` helpers.
- `src/server/auth.ts` — *create*: `verifyPassword(hash, provided)` wrapper + `authMiddleware` (Hono).
- `src/server/auth.test.ts` — *create*: unit tests for the settings round-trip + verify.
- `src/server/app.ts` — *modify*: mount `authMiddleware` on `/api/*`; add `GET /api/health`.
- `src/server/index.ts` — *modify*: startup posture log (password set? tunnel reminder).
- `cli.ts` — *modify*: add `set-password` command + help entry.

**Mobile (`apps/mobile/`)**
- `package.json` — *modify*: add `expo-secure-store`.
- `src/secureConfig.ts` — *create*: `getPassword`/`setPassword` (secure-store) + `authHeaders(pw)`.
- `src/address.ts` — *create*: pure `validateAddress(host, port)` + `wsUrl`/`httpBase` builders.
- `src/address.test.ts` — *create*: custom `eq`/`pass` tests for `validateAddress`.
- `App.tsx` — *modify*: password field + honesty copy (setup); Test-connection + state machine + Edit action; authed fetch/WS; copy renames; Kill/Restart disclosure; contrast; reduced-motion caret; a11y; empty state.
- `src/SessionDrawer.tsx` — *modify*: Kill confirmation; contrast on `newBtn`; remove dead `React` import.

---

# Phase 1 — Server auth

### Task 1: Settings table + password-hash storage

**Files:**
- Modify: `apps/server/src/server/db.ts` (append migration after line 51; add helpers after `renameSession`, ~line 182)
- Test: `apps/server/src/server/auth.test.ts` (created here, extended in Task 3)

**Interfaces:**
- Produces: `getSetting(key: string): string | null`, `setSetting(key: string, value: string): void`, `getAuthHash(): string | null`, `setAuthHash(hash: string): void`.

- [ ] **Step 1: Append migration #4** — in the `migrations` array in `db.ts`, after the version-3 object (line 47-51), add:

```ts
  {
    version: 4,
    name: 'settings',
    up: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
```

- [ ] **Step 2: Add settings helpers** — in `db.ts`, after `renameSession` (line 182), add:

```ts
export function getSetting(key: string): string | null {
  const row = db.query('SELECT value FROM settings WHERE key = $key').get({ $key: key }) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  db.query(`
    INSERT INTO settings (key, value) VALUES ($key, $value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ $key: key, $value: value });
}

const AUTH_HASH_KEY = 'auth_password_hash';
export function getAuthHash(): string | null {
  return getSetting(AUTH_HASH_KEY);
}
export function setAuthHash(hash: string): void {
  setSetting(AUTH_HASH_KEY, hash);
}
```

- [ ] **Step 3: Write the failing test** — create `apps/server/src/server/auth.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { getAuthHash, setAuthHash } from './db';

test('auth hash round-trips through settings', () => {
  expect(getAuthHash()).toBeNull();
  setAuthHash('argon2-hash-placeholder');
  expect(getAuthHash()).toBe('argon2-hash-placeholder');
  setAuthHash('second');
  expect(getAuthHash()).toBe('second'); // upsert overwrites
});
```

- [ ] **Step 4: Run it** — from `apps/server`: `TETHER_DB_PATH=/tmp/tether-test-$$.db bun test src/server/auth.test.ts`
  Expected: PASS (fresh temp DB starts with no hash, then round-trips). Use a temp DB path so the dev DB is untouched.

- [ ] **Step 5: Typecheck + commit**

```bash
bun --cwd apps/server typecheck
git add apps/server/src/server/db.ts apps/server/src/server/auth.test.ts
git commit -m "feat(server): settings table + password-hash storage"
```

---

### Task 2: `tether set-password` CLI command

**Files:**
- Modify: `apps/server/cli.ts` (add function + switch case + help line)

**Interfaces:**
- Consumes: `setAuthHash` from `src/server/db.ts` (Task 1); `Bun.password.hash`.
- Produces: `tether set-password` writes an argon2id hash into the server DB.

- [ ] **Step 1: Add the command** — in `cli.ts`, add this function before the `const cmd = ...` line (after `help()`, ~line 113). It reads the password without echoing, hashes it, and stores it. It imports the DB helper lazily (the DB module opens the SQLite file in `apps/server/config`, so run with cwd = SERVER_DIR):

```ts
async function setPassword(): Promise<void> {
  process.stdout.write('New Tether password: ');
  // Read one line without echo.
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mute echo: overwrite the output write while reading.
  const orig = (rl as unknown as { output: NodeJS.WriteStream }).output;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (s.includes('\n') || s.includes('\r')) orig.write(s);
  };
  const password: string = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  if (!password || password.length < 1) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }
  const { setAuthHash } = await import('./src/server/db');
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
  setAuthHash(hash);
  console.log('Password set. Restart the server if it is running: tether restart');
}
```

- [ ] **Step 2: Add the switch case** — in the `switch (cmd)` block, add before `default:`:

```ts
  case 'set-password':
    await setPassword();
    break;
```

- [ ] **Step 3: Add the help line** — in `help()`, add under `logs`:

```
  set-password  Set the shared access password (required for clients)
```

- [ ] **Step 4: Manual verify**

```bash
cd apps/server
TETHER_DB_PATH=/tmp/tether-cli-test.db bun cli.ts set-password   # type 'hunter2', no echo shown
TETHER_DB_PATH=/tmp/tether-cli-test.db bun -e 'import {getAuthHash} from "./src/server/db"; console.log(getAuthHash()?.startsWith("$argon2id"))'
```
Expected: second command prints `true`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/cli.ts
git commit -m "feat(server): tether set-password CLI (argon2id shared password)"
```

---

### Task 3: Auth middleware + /api/health + WS gate + startup log

**Files:**
- Create: `apps/server/src/server/auth.ts`
- Modify: `apps/server/src/server/app.ts` (mount middleware, add health route)
- Modify: `apps/server/src/server/index.ts` (posture log)
- Test: `apps/server/src/server/auth.test.ts` (extend)

**Interfaces:**
- Consumes: `getAuthHash` (Task 1); `Bun.password.verify`.
- Produces: `verifyPassword(provided: string): Promise<boolean>`, `authMiddleware` (Hono `MiddlewareHandler`).

- [ ] **Step 1: Write `auth.ts`**

```ts
import type { MiddlewareHandler } from 'hono';
import { getAuthHash } from './db';

// Verify a provided password against the stored argon2 hash.
// No password set ⇒ always false (server refuses until `tether set-password`).
export async function verifyPassword(provided: string): Promise<boolean> {
  const hash = getAuthHash();
  if (!hash) return false;
  try {
    return await Bun.password.verify(provided, hash);
  } catch {
    return false;
  }
}

// Reject any request lacking a valid `Authorization: Bearer <password>`.
// Applied to /api/* (including the WS upgrade). Encryption is the tunnel's job;
// this only closes the "anyone on the port gets a shell" hole.
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await verifyPassword(token))) {
    return c.json({ error: 'auth' }, 401);
  }
  await next();
};
```

- [ ] **Step 2: Mount middleware + health route in `app.ts`** — after the `cors(...)` block (ends line 24) and before the `app.get('/', ...)` line (27), add:

```ts
import { authMiddleware } from './auth';

// Everything under /api/* requires the shared password. `/` stays open (liveness).
app.use('/api/*', authMiddleware);

// Lightweight authed reachability + password probe for the client's Test connection.
app.get('/api/health', (c) => c.json({ ok: true }));
```

(Place the `import` at the top with the other imports; place `app.use`/`app.get` after the cors block. The WS route `/api/ws` is under `/api/*`, so it is auto-protected — no change to the upgrade handler needed.)

- [ ] **Step 3: Startup posture log in `index.ts`** — after line 17 (`console.log(\`Tether server listening...\`)`), add:

```ts
import { getAuthHash } from './db';

if (getAuthHash()) {
  console.log('Auth: password required on all /api routes.');
} else {
  console.warn('Auth: NO PASSWORD SET — /api routes will reject all clients. Run: tether set-password');
}
console.log('Transport encryption is the tunnel\'s job (Tailscale / WireGuard / SSH). Bind is 0.0.0.0.');
```

- [ ] **Step 4: Extend the failing test** — append to `auth.test.ts`:

```ts
import { verifyPassword } from './auth';

test('verifyPassword false when no hash set', async () => {
  // NOTE: run this file with a fresh TETHER_DB_PATH so no hash pre-exists.
  expect(await verifyPassword('anything')).toBe(false);
});

test('verifyPassword true only for the set password', async () => {
  const { setAuthHash } = await import('./db');
  setAuthHash(await Bun.password.hash('hunter2', { algorithm: 'argon2id' }));
  expect(await verifyPassword('hunter2')).toBe(true);
  expect(await verifyPassword('wrong')).toBe(false);
});
```

- [ ] **Step 5: Run tests** — from `apps/server`: `TETHER_DB_PATH=/tmp/tether-test-$$.db bun test src/server/auth.test.ts`
  Expected: all PASS. (Run each with a fresh path; the "no hash set" test must run before any `setAuthHash` — Bun runs tests top-to-bottom within a file, and Task 1's tests set a hash, so give this its own temp DB or reorder so the no-hash assertion runs first. Simplest: run `bun test` with a brand-new `TETHER_DB_PATH` each invocation.)

- [ ] **Step 6: Live smoke test**

```bash
cd apps/server
TETHER_DB_PATH=/tmp/tether-live.db bun cli.ts set-password   # set 'hunter2'
TETHER_PORT=8099 TETHER_DB_PATH=/tmp/tether-live.db bun run src/server/index.ts &
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8099/api/sessions            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer hunter2' http://localhost:8099/api/health  # expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8099/                          # expect 200 (liveness, open)
kill %1
```
Expected: `401`, `200`, `200`.

- [ ] **Step 7: Commit**

```bash
bun format && bun --cwd apps/server typecheck
git add apps/server/src/server/auth.ts apps/server/src/server/auth.test.ts apps/server/src/server/app.ts apps/server/src/server/index.ts
git commit -m "feat(server): require shared password on /api, add /api/health probe"
```

---

# Phase 2 — Client auth

### Task 4: expo-secure-store + password/header helpers

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/secureConfig.ts`

**Interfaces:**
- Produces: `getPassword(): Promise<string | null>`, `setPassword(pw: string): Promise<void>`, `clearPassword(): Promise<void>`, `authHeaders(pw: string): Record<string, string>`.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/mobile && npx expo install expo-secure-store
```
Expected: `expo-secure-store` added to `package.json` at the SDK-57-compatible version. (`expo install` picks the right version — do NOT hand-pin.)

- [ ] **Step 2: Write `secureConfig.ts`**

```ts
import * as SecureStore from 'expo-secure-store';

const KEY_PASSWORD = 'tether_password';

export async function getPassword(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_PASSWORD);
  } catch {
    return null;
  }
}

export async function setPassword(pw: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_PASSWORD, pw);
}

export async function clearPassword(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_PASSWORD);
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(pw: string): Record<string, string> {
  return { Authorization: `Bearer ${pw}` };
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
bun --cwd apps/mobile typecheck
git add apps/mobile/package.json apps/mobile/src/secureConfig.ts apps/mobile/bun.lock
git commit -m "feat(mobile): expo-secure-store password + auth header helpers"
```

---

### Task 5: Address helpers (pure) + URL builders

**Files:**
- Create: `apps/mobile/src/address.ts`
- Test: `apps/mobile/src/address.test.ts`

**Interfaces:**
- Produces: `validateAddress(host: string, port: string): { ok: true } | { ok: false; reason: string }`, `httpBase(host: string, port: string): string`, `wsUrl(host, port, params: Record<string,string|number>): string`.

- [ ] **Step 1: Write the failing test** — mirror the existing custom-harness pattern from `src/input.test.ts` (no `bun:test` import; a local `eq`/`pass` runner):

```ts
import { validateAddress, httpBase, wsUrl } from './address';

let passed = 0;
let failed = 0;
function pass(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name); }
}
function eq(name: string, a: unknown, b: unknown) {
  pass(name, JSON.stringify(a) === JSON.stringify(b));
}

eq('valid ipv4', validateAddress('192.168.1.10', '8085'), { ok: true });
eq('valid hostname', validateAddress('my-host.local', '8085'), { ok: true });
eq('empty host', validateAddress('', '8085'), { ok: false, reason: 'Enter a server host or IP.' });
eq('bad port', validateAddress('h', '99999'), { ok: false, reason: 'Port must be between 1 and 65535.' });
eq('non-numeric port', validateAddress('h', 'abc'), { ok: false, reason: 'Port must be between 1 and 65535.' });
eq('httpBase', httpBase('h', '8085'), 'http://h:8085');
eq('wsUrl', wsUrl('h', '8085', { sessionId: 'term-1', sinceId: 0 }), 'ws://h:8085/api/ws?sessionId=term-1&sinceId=0');

console.log(`address.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
```

- [ ] **Step 2: Run it — expect failure** — from `apps/mobile`: `bun run src/address.test.ts`
  Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Write `address.ts`**

```ts
export function validateAddress(
  host: string,
  port: string,
): { ok: true } | { ok: false; reason: string } {
  if (!host.trim()) return { ok: false, reason: 'Enter a server host or IP.' };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return { ok: false, reason: 'Port must be between 1 and 65535.' };
  }
  return { ok: true };
}

export function httpBase(host: string, port: string): string {
  return `http://${host}:${port}`;
}

export function wsUrl(
  host: string,
  port: string,
  params: Record<string, string | number>,
): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `ws://${host}:${port}/api/ws?${qs}`;
}
```

- [ ] **Step 4: Run it — expect pass** — `bun run src/address.test.ts`
  Expected: `address.test: 7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/address.ts apps/mobile/src/address.test.ts
git commit -m "feat(mobile): pure address validation + url builders"
```

---

### Task 6: Wire auth into every fetch + the WebSocket

**Files:**
- Modify: `apps/mobile/App.tsx` (state, connect, killActiveOr, refreshSessions, submitRename, hardResetSession, load-config)

**Interfaces:**
- Consumes: `getPassword`/`authHeaders` (Task 4), `wsUrl`/`httpBase` (Task 5).
- Produces: an in-memory `passwordRef` the render + handlers read; every server call carries the header.

- [ ] **Step 1: Import + password state** — add imports near line 33:

```ts
import { getPassword, setPassword as persistPassword, authHeaders } from './src/secureConfig';
import { httpBase, wsUrl } from './src/address';
```
Add state near line 208 (after `port`):

```ts
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');
  useEffect(() => { passwordRef.current = password; }, [password]);
```

- [ ] **Step 2: Load stored password on mount** — inside `loadConfig` (line 531), extend the `Promise.all` and apply it. Change the destructure + calls:

```ts
        const [savedIp, savedPort, savedSession, savedPw] = await Promise.all([
          AsyncStorage.getItem(KEY_SERVER_IP),
          AsyncStorage.getItem(KEY_PORT),
          AsyncStorage.getItem(KEY_SESSION_ID),
          getPassword(),
        ]);
        if (savedPw) { setPassword(savedPw); passwordRef.current = savedPw; }
```
Only auto-skip configuration when BOTH an address AND a password exist — change the `if (savedIp) {` guard (line 545) to `if (savedIp && savedPw) {`. (A stored address with no password ⇒ stay on setup so the user enters the now-required password — this is the migration path.)

- [ ] **Step 3: Authed WebSocket** — replace the `wsUrl`/`new WebSocket` lines in `connect` (359-361) with:

```ts
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });
    const socket = new WebSocket(url, [], { headers: authHeaders(passwordRef.current) } as never);
```
(The 3-arg RN `WebSocket(url, protocols, options)` sends `headers` on the upgrade. The `as never` silences the DOM-lib WebSocket typing, which omits the RN options arg.)

- [ ] **Step 4: Authed fetches** — add the header to all four `fetch` calls. Each currently sends either no headers or only `Content-Type`. Update:
  - `killActiveOr` (442): `headers: { 'Content-Type': 'application/json', ...authHeaders(passwordRef.current) }`
  - `refreshSessions` (515): `fetch(\`${httpBase(serverIp, port)}/api/sessions\`, { headers: authHeaders(passwordRef.current) })`
  - `submitRename` (737): add `...authHeaders(passwordRef.current)` to its headers object.
  - `hardResetSession` inner fetch (760): add `...authHeaders(passwordRef.current)` to its headers object.

- [ ] **Step 5: Typecheck**

```bash
bun --cwd apps/mobile typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): send shared password on WS + all API requests"
```

---

# Phase 3 — Verifiable setup + recovery

### Task 7: Password field + honesty copy on setup

**Files:**
- Modify: `apps/mobile/App.tsx` (setup JSX 818-851)

- [ ] **Step 1: Fix the subtitle** — change line 821 from
  `Connect to your persistent agent console` to
  `Connect to a terminal on your server`.

- [ ] **Step 2: Add the password field** — after the Port `TextInput` (closes line 846) and before the `connectBtn` `TouchableOpacity` (848), insert:

```tsx
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.configInput}
              value={password}
              onChangeText={setPassword}
              placeholder="Shared server password"
              placeholderTextColor="#64748b"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.configHint}>
              The password controls access. For traffic encryption, run tether behind a
              tunnel (Tailscale, WireGuard, or SSH).
            </Text>
```

- [ ] **Step 3: Add the `configHint` style** — near `configSubtitle` in the stylesheet, add:

```ts
  configHint: { color: '#64748b', fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
```

- [ ] **Step 4: Manual verify (on device)** — setup shows a masked Password field and the tunnel hint; no encryption claim.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): password field + honest tunnel disclosure on setup"
```

---

### Task 8: Test connection before save

**Files:**
- Modify: `apps/mobile/App.tsx` (setup: button, new state, handler)

**Interfaces:**
- Consumes: `validateAddress` (Task 5), `httpBase`/`authHeaders`.
- Produces: `testStatus` state driving the setup button label + result line.

- [ ] **Step 1: Add state** — near line 236:

```ts
  const [testStatus, setTestStatus] = useState<
    { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; msg: string }
  >({ kind: 'idle' });
```

- [ ] **Step 2: Add the test handler** — near `saveConfig` (before line 587):

```ts
  const testConnection = async () => {
    const v = validateAddress(serverIp, port);
    if (!v.ok) { setTestStatus({ kind: 'error', msg: v.reason }); return; }
    if (!password) { setTestStatus({ kind: 'error', msg: 'Enter the server password.' }); return; }
    setTestStatus({ kind: 'testing' });
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/health`, {
        headers: authHeaders(password),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) { setTestStatus({ kind: 'error', msg: 'Wrong password.' }); return; }
      if (!res.ok) { setTestStatus({ kind: 'error', msg: `Server error (${res.status}).` }); return; }
      setTestStatus({ kind: 'ok' });
    } catch {
      setTestStatus({ kind: 'error', msg: 'Unreachable — check the host and port.' });
    }
  };
```

- [ ] **Step 3: Persist the password in `saveConfig`** — inside `saveConfig` (587), after the `AsyncStorage.multiSet` call, add `await persistPassword(password);`. Reset test state on any field edit: change `onChangeText` of the host, port, and password inputs to also call `setTestStatus({ kind: 'idle' })` (wrap in an inline arrow, e.g. `onChangeText={(t) => { setServerIp(t); setTestStatus({ kind: 'idle' }); }}`).

- [ ] **Step 4: Replace the single button** — swap the `connectBtn` block (848-850) for a Test → Save flow:

```tsx
            {testStatus.kind === 'error' && (
              <Text style={styles.testError}>{testStatus.msg}</Text>
            )}
            {testStatus.kind === 'ok' && (
              <Text style={styles.testOk}>Reachable ✓</Text>
            )}
            {testStatus.kind === 'ok' ? (
              <TouchableOpacity style={styles.connectBtn} onPress={saveConfig}>
                <Text style={styles.connectBtnText}>Save & Connect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.connectBtn}
                onPress={testConnection}
                disabled={testStatus.kind === 'testing'}
              >
                <Text style={styles.connectBtnText}>
                  {testStatus.kind === 'testing' ? 'Testing…' : 'Test connection'}
                </Text>
              </TouchableOpacity>
            )}
```

- [ ] **Step 5: Add styles** — near `connectBtnText`:

```ts
  testError: { color: '#f87171', fontSize: 13, marginBottom: 10 },
  testOk: { color: '#4ade80', fontSize: 13, marginBottom: 10 },
```

- [ ] **Step 6: Typecheck + manual verify** — `bun --cwd apps/mobile typecheck`. On device: wrong port ⇒ "Unreachable"; wrong password ⇒ "Wrong password."; correct ⇒ "Reachable ✓" then button becomes "Save & Connect".

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): verifiable Test-connection gate before save"
```

---

### Task 9: Honest connection-state machine + Edit action

**Files:**
- Modify: `apps/mobile/App.tsx` (status type, connect, badge, banner)

**Interfaces:**
- Consumes: existing `connectionStatus`; adds `'auth-failed'` and `hasConnectedRef`.

- [ ] **Step 1: Extend the status union + add the ref** — line 217 type becomes:
  `useState<'connecting' | 'connected' | 'disconnected' | 'auth-failed'>('disconnected')`.
  Add near line 250: `const hasConnectedRef = useRef(false);`

- [ ] **Step 2: Set `hasConnectedRef` on open** — in `connect`, change line 363:
  `socket.onopen = () => { hasConnectedRef.current = true; setConnectionStatus('connected'); };`

- [ ] **Step 3: Surface auth failure from the poll** — in `refreshSessions` (513), read the status and flag auth failure:

```ts
  const refreshSessions = async () => {
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/sessions`, {
        headers: authHeaders(passwordRef.current),
      });
      if (res.status === 401) { setConnectionStatus('auth-failed'); return; }
      const rows = (await res.json()) as DrawerSession[];
      setDrawerSessions(rows);
    } catch {}
  };
```

- [ ] **Step 4: Honest badge** — replace the `connecting` badge text (line 886) `Syncing...` with `Connecting…`, and add an `auth-failed` branch. Replace the header-controls conditional (878-893) so the order is: `connected` → Connected; `auth-failed` → a red "Auth" badge; `connecting` → Connecting…; else → Offline:

```tsx
              {connectionStatus === 'connected' ? (
                <View style={[styles.statusBadge, styles.badgeConnected]}>
                  <View style={[styles.badgeDot, styles.dotConnected]} />
                  <Text style={styles.badgeTextConnected}>Connected</Text>
                </View>
              ) : connectionStatus === 'auth-failed' ? (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Auth</Text>
                </View>
              ) : connectionStatus === 'connecting' ? (
                <View style={[styles.statusBadge, styles.badgeConnecting]}>
                  <ActivityIndicator size={8} color="#fbbf24" style={styles.spinIcon} />
                  <Text style={styles.badgeTextConnecting}>Connecting…</Text>
                </View>
              ) : (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Offline</Text>
                </View>
              )}
```

- [ ] **Step 5: Honest banner + Edit action** — replace the banner block (908-915). Auth failure names the cause; a never-connected socket says Connecting; a dropped socket says Reconnecting (no safety overclaim). All non-connected states expose a direct Edit action:

```tsx
          {connectionStatus !== 'connected' && (
            <View style={styles.reconnectBanner}>
              <Text style={styles.reconnectBannerText}>
                {connectionStatus === 'auth-failed'
                  ? 'Wrong password.'
                  : hasConnectedRef.current
                    ? 'Reconnecting… (session kept running on the server)'
                    : 'Connecting…'}
              </Text>
              <TouchableOpacity
                onPress={() => setIsConfiguring(true)}
                accessibilityRole="button"
                accessibilityLabel="Edit connection settings"
              >
                <Text style={styles.reconnectBannerEdit}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
```

- [ ] **Step 6: Banner layout + Edit style** — ensure `reconnectBanner` lays the text and Edit in a row; add:

```ts
  reconnectBannerEdit: { color: '#22d3ee', fontSize: 12, fontWeight: '600', marginLeft: 12 },
```
If `reconnectBanner` isn't already `flexDirection: 'row'` with `justifyContent: 'space-between'` and `alignItems: 'center'`, add those three properties to it.

- [ ] **Step 7: Reset auth-failed on successful reconnect** — in `connect` (`setConnectionStatus('connecting')`, line 358) leaves any prior `auth-failed`; that's fine because it's immediately overwritten. No extra change needed — the poll re-affirms 401 only if still wrong.

- [ ] **Step 8: Typecheck + manual verify** — `bun --cwd apps/mobile typecheck`. On device: first connect shows "Connecting…" (never "Reconnecting…"); kill Wi-Fi after connecting ⇒ "Reconnecting… (session kept running on the server)"; change server password ⇒ poll flips to "Wrong password." + Auth badge; Edit opens setup.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): honest connection states + direct Edit recovery"
```

---

# Phase 4 — Honest copy + destructive disclosure

### Task 10: Scope-honest copy renames

**Files:**
- Modify: `apps/mobile/App.tsx`

- [ ] **Step 1: Rename labels** — apply these exact edits:
  - Line 1011: `Search output` → `Search displayed transcript`
  - Line 1021: `Snippets` → `Saved commands`
  - Line 1083: `Snippets` (modal title) → `Saved commands`
  - Line 1085: `No snippets yet. Add one below.` → `No saved commands yet. Add one below.`
  - Line 1134: `Select Text` → `Select text (displayed transcript)`
  - Line 1142: `Copy All` → `Copy displayed transcript`
  - Line 1140: `accessibilityLabel="Copy all"` → `accessibilityLabel="Copy displayed transcript"`
  - Line 652: alert body `Terminal contents copied to clipboard.` → `Displayed transcript copied to clipboard.`

- [ ] **Step 2: Typecheck + manual verify** — labels read as displayed-transcript scope; "Saved commands" replaces "Snippets" everywhere user-facing.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): honest transcript-scope + saved-commands copy"
```

---

### Task 11: Destructive-action disclosure (Kill + Restart)

**Files:**
- Modify: `apps/mobile/src/SessionDrawer.tsx` (Kill confirm)
- Modify: `apps/mobile/App.tsx` (Restart copy)

- [ ] **Step 1: Confirm before Kill in the drawer** — in `SessionDrawer.tsx`, import `Alert` from `react-native` (add to the existing RN import) and wrap the kill handler. Find the kill `TouchableOpacity` (~line 141-149) whose `onPress` calls `onKill(session.id)` and change it to:

```tsx
                onPress={() =>
                  Alert.alert(
                    'Kill this terminal?',
                    'The process and its saved output will be deleted. This can\'t be undone.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Kill', style: 'destructive', onPress: () => onKill(session.id) },
                    ],
                  )
                }
```
(Confirm the exact current `onKill` call site and prop name while editing; the prop is `onKill(id)` per `App.tsx:970`.)

- [ ] **Step 2: Disclose history loss on Restart** — in `App.tsx` `hardResetSession` (748), update the Alert body (line 751):
  `'Are you sure you want to terminate and restart the shell process on the server?'`
  → `'This restarts the shell process and clears this terminal\'s scrollback history on the server. This can\'t be undone.'`

- [ ] **Step 3: Typecheck + manual verify** — drawer Kill now prompts and only deletes on confirm; Restart discloses scrollback loss.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/SessionDrawer.tsx apps/mobile/App.tsx
git commit -m "feat(mobile): confirm Kill, disclose Restart history loss"
```

---

# Phase 5 — Details, accessibility, weight

### Task 12: WCAG AA contrast on primary action buttons

**Files:**
- Modify: `apps/mobile/App.tsx` (styles), `apps/mobile/src/SessionDrawer.tsx` (styles)

**Rationale:** white on `#4f46e5` = 3.83:1 (< AA 4.5:1). `#3730a3` on white = 8.4:1 — passes with margin and stays in the indigo family.

- [ ] **Step 1: Replace the action-button background** — change `#4f46e5` → `#3730a3` at:
  - `App.tsx:1348` (`connectBtn`)
  - `App.tsx:1811` (the other action button)
  - `SessionDrawer.tsx:219` (`newBtn`)

- [ ] **Step 2: Verify contrast** — confirm the ratio programmatically:

```bash
bun -e 'const L=h=>{const c=[0,2,4].map(i=>{let v=parseInt(h.slice(1+i,3+i),16)/255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]};const r=(a,b)=>{const x=L(a),y=L(b);return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2)};console.log("white on #3730a3:", r("#ffffff","#3730a3"))'
```
Expected: `white on #3730a3: 8.40` (≥ 4.5 ✓).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/SessionDrawer.tsx
git commit -m "fix(mobile): AA contrast on primary action buttons (#4f46e5->#3730a3)"
```

---

### Task 13: Gate the caret blink on reduced motion

**Files:**
- Modify: `apps/mobile/App.tsx` (import, blink effect 255-259)

- [ ] **Step 1: Import + track the preference** — add `AccessibilityInfo` to the RN import (line 2-21 block). Replace the blink effect (255-259) with:

```ts
  const [blinkOn, setBlinkOn] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (mounted) setReduceMotion(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) =>
      setReduceMotion(v),
    );
    return () => { mounted = false; sub.remove(); };
  }, []);
  useEffect(() => {
    if (reduceMotion) { setBlinkOn(true); return; } // steady caret, no interval
    const iv = setInterval(() => setBlinkOn((v) => !v), 530);
    return () => clearInterval(iv);
  }, [reduceMotion]);
```

- [ ] **Step 2: Typecheck + manual verify** — `bun --cwd apps/mobile typecheck`. On device with Reduce Motion ON: caret is steady (no blink); OFF: caret blinks.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "fix(mobile): steady caret when Reduce Motion is enabled"
```

---

### Task 14: Terminal + hidden-field accessibility

**Files:**
- Modify: `apps/mobile/App.tsx` (terminal Pressable 925, hidden TextInput 1249)

- [ ] **Step 1: Label the terminal press target** — on the `Pressable` at line 925, add:

```tsx
              accessibilityRole="button"
              accessibilityLabel="Terminal. Double-tap to type, long-press to select text."
```

- [ ] **Step 2: Exclude the hidden capture field from the a11y tree** — on the hidden `TextInput` (1249), add:

```tsx
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            accessibilityLabel="Terminal input (hidden)"
```

- [ ] **Step 3: Manual verify (VoiceOver)** — the terminal announces the tap/long-press behavior; VoiceOver does not land on the invisible capture field.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "fix(mobile): terminal a11y label + exclude hidden capture field"
```

---

### Task 15: Empty-terminal state

**Files:**
- Modify: `apps/mobile/App.tsx` (FlatList `ListEmptyComponent` at 937-959)

- [ ] **Step 1: Add an empty state** — add to the `FlatList` (937) a `ListEmptyComponent` shown before any output arrives:

```tsx
                ListEmptyComponent={
                  connectionStatus === 'connected' ? (
                    <Text style={styles.terminalEmpty}>
                      Connected. Type a command to begin.
                    </Text>
                  ) : null
                }
```

- [ ] **Step 2: Add the style** — near `terminalContent`:

```ts
  terminalEmpty: { color: '#64748b', fontSize: 13, padding: 16, fontStyle: 'italic' },
```

- [ ] **Step 3: Manual verify** — a fresh connected terminal with no output shows the hint instead of a blank void; it disappears once output arrives.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): empty-terminal placeholder state"
```

---

### Task 16: Feather-only icon trim + dead-import removal

**Files:**
- Modify: `apps/mobile/App.tsx` (Feather import 26), `apps/mobile/src/SessionDrawer.tsx` (icon import + dead React import line 1)

- [ ] **Step 1: Import only the Feather icon set** — change `App.tsx:26` from
  `import { Feather } from '@expo/vector-icons';`
  to `import Feather from '@expo/vector-icons/Feather';`
  Do the same for the icon import in `SessionDrawer.tsx` (whichever `@expo/vector-icons` import it uses). This pulls only the Feather glyph map + font, so the other icon-font families are tree-shaken out of the bundle.

- [ ] **Step 2: Remove the dead React import** — `SessionDrawer.tsx:1` currently `import React, { useEffect, useRef, useState } from 'react';`. React 19 + the automatic JSX runtime means the default `React` binding is unused. Change to:
  `import { useEffect, useRef, useState } from 'react';`
  (If Biome/TS flags `React` as still referenced anywhere in the file, keep the default import — verify with `grep -n 'React\.' src/SessionDrawer.tsx` first; expect no hits.)

- [ ] **Step 3: Typecheck + lint + verify bundle** — `bun --cwd apps/mobile typecheck` and `bun lint`. Then confirm the trim:

```bash
cd apps/mobile && npx expo export --platform ios --output-dir /tmp/tether-export-trim 2>/dev/null
ls /tmp/tether-export-trim/assets | grep -i '\.ttf' | wc -l   # expect fewer icon-font ttf than the audit's 20
```
Expected: typecheck/lint clean; icon-font `.ttf` count drops (only Feather + Fira Code remain).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/SessionDrawer.tsx
git commit -m "perf(mobile): import Feather-only icon set, drop dead React import"
```

---

## Self-Review

**Spec coverage:**
- Track A (auth) → Tasks 1-3 (server), 4, 6 (client). Honest tunnel copy → Task 7. ✓
- Track B (verifiable/recoverable) → Tasks 5 (validation), 8 (test), 9 (states + Edit). Removes first-connect Reconnecting via `hasConnectedRef` → Task 9. ✓
- Track C (copy + destructive) → Tasks 10 (renames incl. Syncing→Connecting done in Task 9 badge; `Process is preserved safely` replaced in Task 9 banner), 11 (Kill/Restart). ✓
- Track D (details) → 12 (contrast), 13 (reduced motion), 14 (a11y), 15 (empty state), 16 (weight + dead import). ✓
- States checklist (spec): empty→T15, connecting→T9, unreachable/invalid/auth→T8/T9, connected→existing, reconnecting→T9, success→T8, focus/a11y→T14, disabled→T8 (button gated), destructive confirm→T11. ✓
- Migration path (stored host/port, no password) → Task 6 Step 2 (`savedIp && savedPw` guard). ✓
- Cutover (server refuses with no password) → Task 3 (`verifyPassword` false when no hash) + startup warn. ✓

**Type consistency:** `authHeaders`, `httpBase`, `wsUrl`, `validateAddress`, `getPassword`/`setPassword` (secure-store), `getAuthHash`/`setAuthHash`/`getSetting`/`setSetting`, `verifyPassword`, `authMiddleware`, `passwordRef`, `hasConnectedRef`, `testStatus` used consistently across tasks. Client `setPassword` (React state) vs `persistPassword` (secure-store, aliased at import) kept distinct — see Task 6 Step 1.

**Placeholder scan:** no TBD/TODO; every code step shows real code; every copy string is verbatim from the spec.

## Deviation note (spec → plan)

The spec proposed a custom WS close code `4401` for auth failure. The plan instead lets the `/api/*` middleware return HTTP `401` on the WS upgrade and detects auth failure via HTTP `401` on `GET /api/health` (Test connection) and the 4-second `refreshSessions` poll. Reason: RN's `WebSocket` cannot surface a server-chosen close code on a rejected upgrade (it reports a generic `1006`), so an HTTP-based signal is both reliable and already covered by the Test-connection probe. Same user-visible outcome (a distinct "Wrong password." state) with fewer moving parts.
