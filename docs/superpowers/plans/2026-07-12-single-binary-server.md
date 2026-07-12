# Single-Binary Tether Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the tether server as a single self-contained binary (`bun build --compile`) that is both the daemon and the `tether` control CLI, installed via `install.sh` and updated by downloading a new binary from GitHub releases.

**Architecture:** Extract the server bootstrap into `serve()`. A new compiled entry `main.ts` dispatches argv subcommands (serve/start/stop/status/logs/set-password/update/version), folding in the old `cli.ts`. CI cross-compiles four targets and attaches them to each `vX.Y.Z` release. The DB moves to `~/.tether/config/` with auto-migration from the old source-copy location.

**Tech Stack:** Bun (`bun build --compile`, `bun:sqlite`, `Bun.spawn`), Hono, GitHub Releases API, POSIX `sh` (install.sh).

## Global Constraints

- Runtime floor: **Bun ≥ 1.3.14** (PTY `terminal` option). Build host uses `bun` latest in CI.
- Targets (exact): `bun-linux-x64-modern`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`. Asset names: `tether-linux-x64`, `tether-linux-arm64`, `tether-darwin-arm64`, `tether-darwin-x64`.
- Binary IS `tether`; argv dispatch. No bun/git/rsync/node_modules required on the deployed box.
- DB default: `~/.tether/config/tether.db`; `TETHER_DB_PATH` overrides. Migrate from `~/.tether/app/config/tether.db` when the default is used and absent.
- Version embedded via Bun `--define 'process.env.TETHER_VERSION="<tag>"'`; dev = `dev`.
- Repo slug default `samuelloranger/tether`, overridable via `TETHER_REPO_SLUG`. macOS binaries are unsigned.
- Formatting: Biome — 2-space, single quotes, semicolons, trailing commas, width 100. `bun format` before committing server files.
- Dev entrypoint `bun dev:server` / `bun run src/server/index.ts` must keep working.

---

## File Structure

- `apps/server/src/server/paths.ts` — *create*: shared path constants.
- `apps/server/src/server/serve.ts` — *create*: `serve()` (moved from `index.ts`).
- `apps/server/src/server/index.ts` — *modify*: becomes the dev entry calling `serve()`.
- `apps/server/src/server/main.ts` — *create*: compiled binary entry; argv dispatch + control CLI (from `cli.ts`).
- `apps/server/src/server/update.ts` — *create*: pure helpers `assetName`, `shouldUpdate` (unit-tested) + `runUpdate()`.
- `apps/server/src/server/update.test.ts` — *create*.
- `apps/server/src/server/db.ts` — *modify*: default path + migration.
- `apps/server/cli.ts` — *delete*: folded into `main.ts`.
- `apps/server/package.json` — *modify*: `bin` → `main.ts`, add `build:binary`.
- `install.sh` — *create* (repo root).
- `.github/workflows/release.yml` — *modify*: add `server` matrix job.
- `README.md`, `CLAUDE.md` — *modify*: install/update docs + db location.

---

### Task 1: Shared paths module + extract `serve()`

**Files:**
- Create: `apps/server/src/server/paths.ts`
- Create: `apps/server/src/server/serve.ts`
- Modify: `apps/server/src/server/index.ts`

**Interfaces:**
- Produces: `STATE_DIR`, `PID_FILE`, `LOG_FILE`, `DEFAULT_DB_PATH`, `OLD_DB_PATH` (all `string`); `serve(): Promise<void>`.

- [ ] **Step 1: Write `paths.ts`**

```ts
import { homedir } from 'node:os';
import path from 'node:path';

// All persistent tether state lives under ~/.tether.
export const STATE_DIR = path.join(homedir(), '.tether');
export const PID_FILE = path.join(STATE_DIR, 'server.pid');
export const LOG_FILE = path.join(STATE_DIR, 'server.log');

// DB default moved out of the old source-copy dir into ~/.tether/config.
export const DEFAULT_DB_PATH = path.join(STATE_DIR, 'config', 'tether.db');
// Pre-binary installs kept the DB inside the ~/.tether/app source copy.
export const OLD_DB_PATH = path.join(STATE_DIR, 'app', 'config', 'tether.db');
```

- [ ] **Step 2: Write `serve.ts`** — move the current `index.ts` body verbatim into an exported async function:

```ts
import { websocket } from 'hono/bun';
import { app } from './app';
import { getAuthHash, resetRunningSessions, setSessionStatus } from './db';
import { reattachHolders } from './pty';

export async function serve(): Promise<void> {
  const PORT = Number(process.env.TETHER_PORT ?? 8085);

  // A previous server process may have died with sessions still marked running.
  // Their PTYs live in detached holder processes, so first reattach to the ones
  // that survived, then mark whatever is left as stopped.
  resetRunningSessions();
  for (const id of await reattachHolders()) {
    setSessionStatus(id, 'running');
    console.log(`Reattached to surviving session "${id}"`);
  }

  console.log(`Tether server listening on :${PORT}`);

  if (getAuthHash()) {
    console.log('Auth: password required on all /api routes.');
  } else {
    console.warn(
      'Auth: NO PASSWORD SET — /api routes will reject all clients. Run: tether set-password',
    );
  }
  console.log(
    "Transport encryption is the tunnel's job (Tailscale / WireGuard / SSH). Bind is 0.0.0.0.",
  );

  Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    fetch: app.fetch,
    websocket,
    error(err) {
      console.error('Unhandled request error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  });
}
```

- [ ] **Step 3: Replace `index.ts` body** with the dev entry:

```ts
// Dev entry: `bun dev:server` / `bun run src/server/index.ts`. The compiled
// binary uses main.ts instead; both call serve().
import { serve } from './serve';

await serve();
```

- [ ] **Step 4: Verify dev boot** — from `apps/server`:

```bash
TETHER_PORT=8093 TETHER_DB_PATH=/tmp/t1.db bun run src/server/index.ts &
sleep 1.2
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8093/    # expect 200
kill %1; rm -f /tmp/t1.db
```
Expected: `200`.

- [ ] **Step 5: Typecheck + commit**

```bash
bun --cwd apps/server typecheck
bun format
git add apps/server/src/server/paths.ts apps/server/src/server/serve.ts apps/server/src/server/index.ts
git commit -m "refactor(server): extract serve() + shared paths module"
```

---

### Task 2: DB default path + migration

**Files:**
- Modify: `apps/server/src/server/db.ts:4-12`

**Interfaces:**
- Consumes: `DEFAULT_DB_PATH`, `OLD_DB_PATH` (Task 1).

- [ ] **Step 1: Rewrite the path/init block** — replace the top of `db.ts` (imports + `DB_DIR`/`DB_PATH`/`mkdirSync`/`new Database`, currently lines 1-12) with:

```ts
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH, OLD_DB_PATH } from './paths';

const usingDefault = !process.env.TETHER_DB_PATH;
const DB_PATH = process.env.TETHER_DB_PATH ?? DEFAULT_DB_PATH;
const DB_DIR = path.dirname(DB_PATH);
mkdirSync(DB_DIR, { recursive: true });

// One-time migration: pre-binary installs kept the DB in the ~/.tether/app
// source copy. If we're on the default path, it doesn't exist yet, and the old
// one does, carry it over so sessions + the password survive the upgrade.
if (usingDefault && !existsSync(DB_PATH) && existsSync(OLD_DB_PATH)) {
  console.log(`Migrating database from ${OLD_DB_PATH} to ${DB_PATH}`);
  copyFileSync(OLD_DB_PATH, DB_PATH);
}

export const db = new Database(DB_PATH, { create: true });
```
(Keep everything below line 12 — the `PRAGMA`, migrations, helpers — unchanged.)

- [ ] **Step 2: Verify migration** — from `apps/server`:

```bash
rm -rf /tmp/thome && mkdir -p /tmp/thome/.tether/app/config
# seed an old DB with a marker table
HOME=/tmp/thome bun -e 'import {Database} from "bun:sqlite"; const d=new Database("/tmp/thome/.tether/app/config/tether.db",{create:true}); d.exec("CREATE TABLE marker(x)"); d.exec("INSERT INTO marker VALUES (42)")'
# import db.ts with default path (HOME drives ~/.tether); should migrate
HOME=/tmp/thome bun -e 'const {db}=await import("./src/server/db"); console.log("marker:", db.query("SELECT x FROM marker").get())'
ls /tmp/thome/.tether/config/tether.db && echo "migrated ✓"
rm -rf /tmp/thome
```
Expected: `marker: { x: 42 }` and `migrated ✓`.

- [ ] **Step 3: Verify override bypasses migration** — `TETHER_DB_PATH` set ⇒ no migration:

```bash
rm -rf /tmp/thome && mkdir -p /tmp/thome/.tether/app/config
HOME=/tmp/thome TETHER_DB_PATH=/tmp/explicit.db bun -e 'const {db}=await import("./src/server/db"); db.query("SELECT 1").get(); console.log("ok")'
[ ! -f /tmp/thome/.tether/config/tether.db ] && echo "override bypassed migration ✓"
rm -rf /tmp/thome /tmp/explicit.db
```
Expected: `override bypassed migration ✓`.

- [ ] **Step 4: Confirm the suite still isolates** — the bun-test preload (`test-preload.ts`) sets `TETHER_DB_PATH`, so `usingDefault` is false there:

```bash
bun test 2>&1 | tail -4
```
Expected: all pass, no migration log.

- [ ] **Step 5: Commit**

```bash
bun --cwd apps/server typecheck && bun format
git add apps/server/src/server/db.ts
git commit -m "feat(server): default DB to ~/.tether/config with migration from old path"
```

---

### Task 3: `main.ts` — argv dispatch + control CLI (fold `cli.ts`)

**Files:**
- Create: `apps/server/src/server/main.ts`
- Delete: `apps/server/cli.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: `serve` (Task 1), `STATE_DIR`/`PID_FILE`/`LOG_FILE` (Task 1), `setAuthHash` (`db.ts`), `runUpdate` (Task 4 — imported lazily so this task compiles before Task 4 lands: use a dynamic `import('./update')`).
- Produces: `VERSION: string`, `selfServeArgv(): string[]`, `runningPid(): number | null`, `start()`, `stop()`, `status()`, the `tether` binary behavior.

- [ ] **Step 1: Write `main.ts`** — migrate `cli.ts` verbatim for start/stop/status/logs/set-password/readHidden, adapt `start` to re-exec self, add `serve`/`version` and dispatch:

```ts
#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { LOG_FILE, PID_FILE, STATE_DIR } from './paths';
import { serve } from './serve';

const VERSION = process.env.TETHER_VERSION ?? 'dev';
const COMPILED = VERSION !== 'dev';
const PORT = process.env.TETHER_PORT ?? '8085';

mkdirSync(STATE_DIR, { recursive: true });

// argv needed to re-launch this same program with `serve`. Compiled binary:
// [binary, 'serve']. Dev (bun run main.ts): [bun, main.ts, 'serve'].
function selfServeArgv(): string[] {
  return COMPILED
    ? [process.execPath, 'serve']
    : [process.execPath, import.meta.path, 'serve'];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  return pid && alive(pid) ? pid : null;
}

function start(): void {
  const existing = runningPid();
  if (existing) {
    console.log(`tether already running (pid ${existing}) on :${PORT}`);
    return;
  }
  const out = openSync(LOG_FILE, 'a');
  // Scrub Claude Code agent vars so a daemon (re)started from an agent's shell
  // doesn't leak CLAUDE_CODE_CHILD_SESSION into every tether PTY (breaks /resume).
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE')) delete env[k];
  }
  const [cmd, ...args] = selfServeArgv();
  const child = spawn(cmd, args, {
    cwd: homedir(),
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`tether started (pid ${child.pid}) on :${PORT}`);
  console.log(`logs: ${LOG_FILE}`);
}

function stop(): void {
  const pid = runningPid();
  if (!pid) {
    console.log('tether not running');
    rmSync(PID_FILE, { force: true });
    return;
  }
  try {
    process.kill(pid);
  } catch {}
  rmSync(PID_FILE, { force: true });
  console.log(`tether stopped (pid ${pid})`);
}

async function status(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    console.log('tether: stopped');
    return;
  }
  let reachable = false;
  try {
    const res = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    reachable = res.ok;
  } catch {}
  console.log(
    `tether: running (pid ${pid}) on :${PORT} — HTTP ${reachable ? 'ok' : 'not responding'}`,
  );
}

function logs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log('no logs yet');
    return;
  }
  spawn('tail', ['-n', '80', '-f', LOG_FILE], { stdio: 'inherit' });
}

// Read a line of hidden input: raw-mode manual char loop on a TTY (prompt stays
// visible, nothing echoes), plain line read when piped.
function readHidden(promptText: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(promptText);
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.resume();
      const onData = (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.off('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.on('data', onData);
    });
  }
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish(() => resolve(buf));
        if (c === '\x03') return finish(() => reject(new Error('cancelled')));
        if (c === '\x7f' || c === '\b') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function setPassword(): Promise<void> {
  let password: string;
  try {
    password = await readHidden('New Tether password: ');
  } catch {
    console.error('\nCancelled.');
    process.exit(1);
  }
  if (!password || password.length < 1) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }
  const { setAuthHash } = await import('./db');
  setAuthHash(await Bun.password.hash(password, { algorithm: 'argon2id' }));
  console.log('Password set. Restart the server if it is running: tether restart');
}

function help(): void {
  console.log(`tether — persistent remote-shell server (v${VERSION})

Usage: tether <command>

  (none) / serve   Run the server in the foreground
  start            Start the server in the background (:${PORT})
  stop             Stop the background server
  restart          Stop then start
  status           Show running state + HTTP health
  logs             Follow the server log (tail -f)
  set-password     Set the shared access password (required for clients)
  update           Download the latest release binary and restart
  version          Print the version
  help             Show this help

Env: TETHER_PORT (default 8085), TETHER_DB_PATH, TETHER_REPO_SLUG
State: ${STATE_DIR}`);
}

const cmd = process.argv[COMPILED ? 2 : 2] ?? 'serve';
switch (cmd) {
  case 'serve':
    await serve();
    break;
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    await status();
    break;
  case 'logs':
    logs();
    break;
  case 'set-password':
    await setPassword();
    break;
  case 'update': {
    const { runUpdate } = await import('./update');
    await runUpdate({ version: VERSION, compiled: COMPILED, start, stop, runningPid });
    break;
  }
  case 'version':
    console.log(VERSION);
    break;
  default:
    help();
}
```

**Note on `process.argv`:** Bun's compiled binary and `bun run main.ts` both expose the first user arg at `process.argv[2]`, so the index is `2` in both modes (the ternary documents this intentionally and is safe to simplify to `process.argv[2]`). Default is `serve` so a bare `tether` (or the daemon exec) runs the server.

- [ ] **Step 2: Delete `cli.ts` and update `package.json`** — remove `apps/server/cli.ts`; set `"bin": { "tether": "./src/server/main.ts" }` and add to `scripts`:

```json
    "build:binary": "bun build --compile --minify --define process.env.TETHER_VERSION=\\\"${TETHER_VERSION:-dev}\\\" --outfile dist/tether src/server/main.ts"
```

- [ ] **Step 3: Verify dispatch in dev** — from `apps/server`:

```bash
H=/tmp/thome; rm -rf $H; mkdir -p $H
echo "version:"; HOME=$H bun run src/server/main.ts version         # expect: dev
echo "serve boots:"; HOME=$H TETHER_PORT=8092 bun run src/server/main.ts serve & sleep 1.2; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8092/; kill %1
echo "start/status/stop:"; HOME=$H TETHER_PORT=8092 bun run src/server/main.ts start; sleep 1.2; HOME=$H TETHER_PORT=8092 bun run src/server/main.ts status; HOME=$H TETHER_PORT=8092 bun run src/server/main.ts stop
rm -rf $H
```
Expected: `dev`; `200`; `tether started …`; `tether: running … HTTP ok`; `tether stopped …`.

- [ ] **Step 4: Verify set-password (PTY)** — reuse the PTY harness pattern from the prior fix; expect prompt visible, hidden input, `Password set`, hash written. (Run against a temp `HOME`.)

- [ ] **Step 5: Commit**

```bash
bun --cwd apps/server typecheck && bun format
git add apps/server/src/server/main.ts apps/server/package.json
git rm apps/server/cli.ts
git commit -m "feat(server): single tether binary entry (argv dispatch, folds cli.ts)"
```

---

### Task 4: `update` command + pure helpers

**Files:**
- Create: `apps/server/src/server/update.ts`
- Create: `apps/server/src/server/update.test.ts`

**Interfaces:**
- Produces: `assetName(platform: NodeJS.Platform, arch: string): string`, `shouldUpdate(current: string, latest: string): boolean`, `runUpdate(ctx: { version: string; compiled: boolean; start: () => void; stop: () => void; runningPid: () => number | null }): Promise<void>`.

- [ ] **Step 1: Write the failing test** (custom `ok()` style, run via `bun run`):

```ts
import { assetName, shouldUpdate } from './update';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

ok(assetName('linux', 'x64') === 'tether-linux-x64', 'linux x64');
ok(assetName('linux', 'arm64') === 'tether-linux-arm64', 'linux arm64');
ok(assetName('darwin', 'arm64') === 'tether-darwin-arm64', 'darwin arm64');
ok(assetName('darwin', 'x64') === 'tether-darwin-x64', 'darwin x64');
let threw = false;
try {
  assetName('win32', 'x64');
} catch {
  threw = true;
}
ok(threw, 'unsupported platform throws');

ok(shouldUpdate('v1.0.9', 'v1.1.0') === true, 'different -> update');
ok(shouldUpdate('v1.1.0', 'v1.1.0') === false, 'equal -> skip');
ok(shouldUpdate('dev', 'v1.1.0') === true, 'dev -> update');

console.log(`update.test: ${pass} passed`);
```

- [ ] **Step 2: Run — expect fail** — from `apps/server`: `bun run src/server/update.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `update.ts`**

```ts
import { chmodSync, renameSync } from 'node:fs';
import path from 'node:path';

const REPO_SLUG = process.env.TETHER_REPO_SLUG ?? 'samuelloranger/tether';

// Map the running platform/arch to the release asset name. Throws on unsupported.
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  return `tether-${os}-${a}`;
}

export function shouldUpdate(current: string, latest: string): boolean {
  return current !== latest;
}

interface UpdateCtx {
  version: string;
  compiled: boolean;
  start: () => void;
  stop: () => void;
  runningPid: () => number | null;
}

export async function runUpdate(ctx: UpdateCtx): Promise<void> {
  if (!ctx.compiled) {
    console.error('update only works on an installed binary. In dev, use git + bun run.');
    process.exit(1);
  }
  const asset = assetName(process.platform, process.arch);
  console.log('Checking latest release…');
  const api = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
  const res = await fetch(api, { headers: { 'User-Agent': 'tether-update' } });
  if (!res.ok) {
    console.error(`Could not query releases (${res.status}).`);
    process.exit(1);
  }
  const rel = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  if (!shouldUpdate(ctx.version, rel.tag_name)) {
    console.log(`Already up to date (${ctx.version}).`);
    return;
  }
  const match = rel.assets.find((x) => x.name === asset);
  if (!match) {
    console.error(`Release ${rel.tag_name} has no asset "${asset}".`);
    process.exit(1);
  }

  console.log(`Downloading ${asset} ${rel.tag_name}…`);
  const dl = await fetch(match.browser_download_url, { headers: { 'User-Agent': 'tether-update' } });
  if (!dl.ok) {
    console.error(`Download failed (${dl.status}).`);
    process.exit(1);
  }
  // Write next to the current binary so the final rename is same-filesystem/atomic.
  const target = process.execPath;
  const tmp = path.join(path.dirname(target), '.tether.new');
  await Bun.write(tmp, dl);
  chmodSync(tmp, 0o755);

  // Sanity-check the downloaded binary before swapping it in.
  const check = Bun.spawnSync([tmp, 'version']);
  const printed = check.stdout.toString().trim();
  if (!check.success || printed !== rel.tag_name) {
    console.error(`Downloaded binary failed self-check (got "${printed}"). Aborting.`);
    process.exit(1);
  }

  const wasRunning = ctx.runningPid() !== null;
  renameSync(tmp, target); // atomic swap; running process keeps the old inode
  console.log(`Updated to ${rel.tag_name}.`);
  if (wasRunning) {
    console.log('Restarting server…');
    ctx.stop();
    ctx.start();
  } else {
    console.log('Server not running. Start it with: tether start');
  }
}
```

- [ ] **Step 4: Run — expect pass** — `bun run src/server/update.test.ts` → `update.test: 8 passed`.

- [ ] **Step 5: Commit**

```bash
bun --cwd apps/server typecheck && bun format
git add apps/server/src/server/update.ts apps/server/src/server/update.test.ts
git commit -m "feat(server): tether update — download + atomic-swap release binary"
```

---

### Task 5: Compile smoke + CI release matrix

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Local host-target compile smoke** — prove the real binary builds + boots + reports version:

```bash
cd apps/server
TETHER_VERSION=v0.0.0-smoke bun run build:binary
H=/tmp/thome; rm -rf $H; mkdir -p $H
echo "version:"; HOME=$H ./dist/tether version           # expect v0.0.0-smoke
HOME=$H TETHER_PORT=8091 ./dist/tether serve & sleep 1.2
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8091/            # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8091/api/sessions # 401
kill %1; rm -rf $H dist/tether
```
Expected: `v0.0.0-smoke`, `200`, `401`.

- [ ] **Step 2: Add the `server` job to `release.yml`** — append after the `android` job (before `altstore`), and add it to `altstore`'s `needs` so the manifest still waits on iOS only (leave `altstore.needs` as `ios`):

```yaml
  server:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - target: bun-linux-x64-modern
            asset: tether-linux-x64
          - target: bun-linux-arm64
            asset: tether-linux-arm64
          - target: bun-darwin-arm64
            asset: tether-darwin-arm64
          - target: bun-darwin-x64
            asset: tether-darwin-x64
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install workspace deps
        run: bun install
      - name: Compile ${{ matrix.asset }}
        working-directory: apps/server
        run: |
          bun build --compile --minify \
            --target=${{ matrix.target }} \
            --define 'process.env.TETHER_VERSION="'"${GITHUB_REF_NAME}"'"' \
            --outfile "${{ matrix.asset }}" \
            src/server/main.ts
      - name: Attach to release
        working-directory: apps/server
        run: gh release upload "$GITHUB_REF_NAME" "${{ matrix.asset }}" --clobber
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 3: Validate the workflow YAML**

```bash
cd /home/samuelloranger/sites/tether
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('release.yml valid')"
```
Expected: `release.yml valid`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): cross-compile server binaries for 4 targets"
```

---

### Task 6: `install.sh`

**Files:**
- Create: `install.sh` (repo root)

- [ ] **Step 1: Write `install.sh`**

```sh
#!/bin/sh
# Tether server installer. Detects OS/arch, downloads the matching binary from
# the latest GitHub release, installs to ~/.local/bin/tether.
#   curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | sh
# Env: TETHER_VERSION=vX.Y.Z pins a version; DRY_RUN=1 prints the plan only.
set -eu

REPO="${TETHER_REPO_SLUG:-samuelloranger/tether}"
BIN_DIR="${HOME}/.local/bin"
DEST="${BIN_DIR}/tether"

os="$(uname -s)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="tether-${os}-${arch}"

if [ -n "${TETHER_VERSION:-}" ]; then
  tag="$TETHER_VERSION"
else
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d '"' -f 4)"
fi
[ -n "$tag" ] || { echo "Could not resolve latest release tag" >&2; exit 1; }

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "would download: $url"
  echo "would install to: $DEST"
  exit 0
fi

echo "Installing tether ${tag} (${asset})…"
mkdir -p "$BIN_DIR"
curl -fsSL "$url" -o "$DEST"
chmod +x "$DEST"

echo "Installed to $DEST"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac
if [ -d "${HOME}/.tether/app" ]; then
  echo "Note: old ~/.tether/app detected. Your database migrates automatically on first run; you can delete ~/.tether/app afterward."
fi
echo "Next: tether set-password && tether start"
```

- [ ] **Step 2: Verify DRY_RUN arch detection** — resolves the correct asset URL for this host:

```bash
chmod +x install.sh
DRY_RUN=1 ./install.sh
```
Expected: prints `would download: https://github.com/samuelloranger/tether/releases/download/<tag>/tether-<os>-<arch>` matching this machine, and `would install to: ~/.local/bin/tether`.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh — one-line binary install from latest release"
```

---

### Task 7: Docs — README + CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README install/update section** — replace the server run/install instructions with the binary flow. Add exactly:

```md
## Install (server)

```sh
curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | sh
tether set-password
tether start
```

Update later with `tether update`. On macOS the binary is unsigned — the first
run may need: `xattr -d com.apple.quarantine ~/.local/bin/tether`.

Data (sessions + password) lives in `~/.tether/config/tether.db`; override with
`TETHER_DB_PATH`. Dev from source: `bun dev:server`.
```

- [ ] **Step 2: Update `CLAUDE.md`** — change the daemon/DB lines to reflect the binary: the CLI is the compiled `tether` binary (subcommands serve/start/stop/status/logs/set-password/update/version); DB + state live in `~/.tether/` (`config/tether.db`), overridable via `TETHER_DB_PATH`; note `bun dev:server` runs from source and the release workflow ships the four server binaries alongside the mobile artifacts.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: binary install/update instructions + state locations"
```

---

## Self-Review

**Spec coverage:**
- One binary = daemon + CLI → Task 3 (`main.ts` dispatch, `serve` case). ✓
- Extract `serve()` → Task 1. ✓
- DB default `~/.tether/config` + migration from `~/.tether/app` → Task 2. ✓
- `update` download/atomic-swap/version-skip/sanity-check → Task 4. ✓
- 4-target CI matrix + version `--define` → Task 5. ✓
- `install.sh` arch detect + DRY_RUN → Task 6. ✓
- Docs / macOS unsigned / db location → Task 7. ✓
- Dev entry unchanged → Task 1 Step 3 (`index.ts` calls `serve`), verified each task. ✓
- Delete `cli.ts` → Task 3 Step 2. ✓

**Placeholder scan:** no TBD/TODO; every code step is complete; commands have expected output.

**Type consistency:** `serve()`, `assetName`, `shouldUpdate`, `runUpdate(ctx)`, `selfServeArgv`, `runningPid`, `start`, `stop`, `VERSION`, `COMPILED`, path constants used consistently across Tasks 1/3/4. `runUpdate` is imported lazily in `main.ts` (Task 3) and defined in Task 4 — signature matches the `UpdateCtx` shape passed at the call site.

## Notes / risks

- `bun build --compile --target=` cross-compiles from the Linux CI runner to all four targets (Bun supports cross-target compile); no macOS runner needed for the server job.
- Atomic self-replace relies on same-directory rename (Task 4 writes `.tether.new` beside `process.execPath`). If `~/.local/bin` is read-only, `update` fails cleanly before the rename.
- macOS binaries are unsigned (documented). Windows unsupported (documented).
