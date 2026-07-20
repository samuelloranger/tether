# Native Secret Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Tether desktop client's server password from plaintext `localStorage` into the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service), falling back to `localStorage` when the keychain is unavailable.

**Architecture:** A Rust `keyring` crate integration exposes three new `#[tauri::command]`s (`secure_get_password`/`secure_set_password`/`secure_clear_password`) from `main.rs`, following the exact pattern of the existing `ws_connect`/`ws_send`/`ws_close` commands. `secureConfig.web.ts` keeps its current exported interface unchanged and internally branches on `isTauri()` (relocated from `wsTransport.ts` to `platform.ts`) to call the Rust commands when available, falling back to `localStorage` on any failure.

**Tech Stack:** Rust (`keyring` crate v3, Tauri v2 commands), TypeScript (`@tauri-apps/api/core` dynamic import), Bun test runner (`bun:test` with `mock.module`).

## Global Constraints

- `secureConfig.ts` (native iOS/Android, `expo-secure-store`) is untouched — desktop-only change.
- `secureConfig.web.ts`'s exported interface (`getPassword`/`setPassword`/`clearPassword`/`authHeaders`) does not change shape — no caller elsewhere in the codebase needs to change.
- No migration of existing `localStorage` passwords into the keychain — per product decision, existing desktop users re-enter their password once after upgrading.
- Any Rust-side keyring failure must fall back to `localStorage`, never surface as a hard error to the caller.
- `keyring::Error::NoEntry` is a normal empty state (`Ok(None)`/`Ok(())`), not an error.

---

### Task 1: Relocate `isTauri()` to `platform.ts`

**Files:**
- Modify: `apps/mobile/src/platform.ts` (add `isTauri`)
- Modify: `apps/mobile/src/wsTransport.ts:24-26` (remove the local definition, import from `./platform`)

**Interfaces:**
- Produces: `isTauri(): boolean` exported from `apps/mobile/src/platform.ts` — checks `typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'`.
- Consumes: nothing new.

- [ ] **Step 1: Move the function**

Current `apps/mobile/src/platform.ts`:

```typescript
import { Platform } from 'react-native';

// The web bundle only ever runs inside the Tauri desktop shell (plain browsers
// can't authenticate the WS). So Platform.OS === 'web' means "desktop", and we
// use it to swap the mobile chrome (utility bar, overlay drawer, tap-to-type)
// for desktop conventions (physical keyboard, docked sidebar, mouse selection).
export const isDesktop = Platform.OS === 'web';

// macOS uses Cmd (not Ctrl) as the clipboard modifier, so Ctrl+C stays SIGINT.
// Detected from the webview UA since this only ever runs on the desktop build.
export const isMacDesktop =
  isDesktop && typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);
```

Append to it:

```typescript

// Tauri injects __TAURI_INTERNALS__ into the webview global. True only inside
// the packaged desktop app — false for the plain-browser `bun run web` dev
// preview, which has no Rust backend to invoke.
export function isTauri(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}
```

In `apps/mobile/src/wsTransport.ts`, replace:

```typescript
// Tauri injects __TAURI_INTERNALS__ into the webview global.
export function isTauri(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}
```

with:

```typescript
import { isTauri } from './platform';
```

placed with the other imports at the top of the file (`apps/mobile/src/wsTransport.ts:1`, right after `import { Platform } from 'react-native';`).

- [ ] **Step 2: Typecheck and run the full suite**

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

Run: `bun --cwd apps/mobile test`
Expected: `60 pass`, `0 fail` (same counts as before this change — this is a pure relocation, no behavior change, no test currently covers `isTauri`/`openTerminalSocket` directly).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/platform.ts apps/mobile/src/wsTransport.ts
git commit -m "refactor(mobile): relocate isTauri() to platform.ts"
```

---

### Task 2: Rust keyring commands

**Files:**
- Modify: `apps/mobile/src-tauri/Cargo.toml` (add `keyring` dependency)
- Modify: `apps/mobile/src-tauri/src/main.rs` (add 3 commands + register them)

**Interfaces:**
- Produces (Tauri commands, invoked by name from TypeScript via `invoke()`):
  - `secure_get_password() -> Result<Option<String>, String>`
  - `secure_set_password(password: String) -> Result<(), String>`
  - `secure_clear_password() -> Result<(), String>`
- Consumes: nothing from Task 1 (independent of the TS-side relocation).

- [ ] **Step 1: Add the `keyring` dependency**

In `apps/mobile/src-tauri/Cargo.toml`, in the `[dependencies]` section, add a line after `tauri-plugin-opener = "2"`:

```toml
keyring = "3"
```

- [ ] **Step 2: Add the commands to `main.rs`**

In `apps/mobile/src-tauri/src/main.rs`, add this block right after the `is_updatable` function (before the `// NOTE: the webview CSP...` comment):

```rust
// Desktop password storage backed by the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service via the `keyring` crate). Falls back
// to localStorage on the TypeScript side (secureConfig.web.ts) if any of these
// fail — e.g. no Secret Service daemon running on a minimal Linux desktop.
fn secure_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("tether-desktop", "server-password").map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_get_password() -> Result<Option<String>, String> {
    match secure_entry()?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secure_set_password(password: String) -> Result<(), String> {
    secure_entry()?.set_password(&password).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_clear_password() -> Result<(), String> {
    match secure_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

Then update the `invoke_handler!` list (currently):

```rust
        .invoke_handler(tauri::generate_handler![
            ws_connect,
            ws_send,
            ws_close,
            is_updatable
        ])
```

to:

```rust
        .invoke_handler(tauri::generate_handler![
            ws_connect,
            ws_send,
            ws_close,
            is_updatable,
            secure_get_password,
            secure_set_password,
            secure_clear_password
        ])
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/mobile/src-tauri && cargo check`
Expected: `Finished` with no errors (warnings about unused code are not expected here since all three commands are registered in `invoke_handler!`).

There is no Rust test infrastructure in this repo (the existing `ws_connect` etc. aren't unit-tested either) — `cargo check` is the verification for this task. The full get/set/clear round-trip is verified manually in Task 3's final step, once the TypeScript side can call these commands from the running app.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src-tauri/Cargo.toml apps/mobile/src-tauri/src/main.rs
git commit -m "feat(desktop): add OS-keychain password commands via the keyring crate"
```

Note: this will also modify `apps/mobile/src-tauri/Cargo.lock` (new `keyring` dependency tree) — include it in the same commit.

---

### Task 3: Wire `secureConfig.web.ts` to the keychain, with tests

**Files:**
- Modify: `apps/mobile/src/secureConfig.web.ts`
- Create: `apps/mobile/src/secureConfig.web.test.ts`

**Interfaces:**
- Consumes: `isTauri(): boolean` from `./platform` (Task 1); `secure_get_password`/`secure_set_password`/`secure_clear_password` Tauri commands (Task 2), invoked via `(await import('@tauri-apps/api/core')).invoke`.
- Produces: no new exports — `getPassword`/`setPassword`/`clearPassword`/`authHeaders` keep their existing signatures from `apps/mobile/src/secureConfig.ts`'s sibling file.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/secureConfig.web.test.ts`:

```typescript
import { expect, mock, test, beforeEach } from 'bun:test';

const invoke = mock((_cmd: string, _args?: unknown) => Promise.resolve(undefined));
mock.module('@tauri-apps/api/core', () => ({ invoke }));

let tauriActive = true;
mock.module('./platform', () => ({
  isTauri: () => tauriActive,
}));

const localStorageStub = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    reset: () => {
      store = {};
    },
  };
})();
// @ts-expect-error test-only global stub
globalThis.localStorage = localStorageStub;

const { getPassword, setPassword, clearPassword } = await import('./secureConfig.web');

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve(undefined));
  localStorageStub.reset();
  tauriActive = true;
});

test('getPassword calls the Rust keychain command when running under Tauri', async () => {
  invoke.mockImplementation(() => Promise.resolve('hunter2'));
  const pw = await getPassword();
  expect(invoke).toHaveBeenCalledWith('secure_get_password');
  expect(pw).toBe('hunter2');
});

test('getPassword falls back to localStorage when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no secret service')));
  localStorageStub.setItem('tether_password', 'fallback-pw');
  const pw = await getPassword();
  expect(pw).toBe('fallback-pw');
});

test('setPassword writes to the keychain and clears any stale localStorage entry', async () => {
  localStorageStub.setItem('tether_password', 'old-plaintext');
  await setPassword('new-pw');
  expect(invoke).toHaveBeenCalledWith('secure_set_password', { password: 'new-pw' });
  expect(localStorageStub.getItem('tether_password')).toBeNull();
});

test('setPassword falls back to localStorage when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('locked')));
  await setPassword('new-pw');
  expect(localStorageStub.getItem('tether_password')).toBe('new-pw');
});

test('clearPassword calls the Rust command when running under Tauri', async () => {
  await clearPassword();
  expect(invoke).toHaveBeenCalledWith('secure_clear_password');
});

test('non-Tauri (plain browser dev preview) always uses localStorage directly', async () => {
  tauriActive = false;
  await setPassword('browser-pw');
  expect(invoke).not.toHaveBeenCalled();
  expect(localStorageStub.getItem('tether_password')).toBe('browser-pw');
  const pw = await getPassword();
  expect(pw).toBe('browser-pw');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun --cwd apps/mobile test src/secureConfig.web.test.ts`
Expected: FAIL — `secureConfig.web.ts` doesn't call `isTauri()`/`invoke` yet, so `invoke` is never called and the keychain-path assertions fail.

- [ ] **Step 3: Rewrite `secureConfig.web.ts`**

Replace the full contents of `apps/mobile/src/secureConfig.web.ts` with:

```typescript
// Web build: on the Tauri desktop shell, the password lives in the OS keychain
// (Rust `keyring` crate, invoked via secure_get_password/secure_set_password/
// secure_clear_password — see apps/mobile/src-tauri/src/main.rs). Falls back to
// localStorage when the keychain call fails (e.g. no Secret Service daemon on a
// minimal Linux desktop) or when running the plain-browser `bun run web` dev
// preview, which has no Rust backend to invoke at all. Same interface as the
// native module (secureConfig.ts); Metro resolves this file over it on web.
import { isTauri } from './platform';

const KEY_PASSWORD = 'tether_password';

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export async function getPassword(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('secure_get_password');
    } catch {
      // Keychain unavailable — fall through to localStorage below.
    }
  }
  return ls()?.getItem(KEY_PASSWORD) ?? null;
}

export async function setPassword(pw: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_set_password', { password: pw });
      // Keychain write succeeded — clear any stale plaintext copy from before
      // this feature shipped. No migration in the other direction: existing
      // users re-enter their password once, then it lives only in the keychain.
      ls()?.removeItem(KEY_PASSWORD);
      return;
    } catch {
      // Keychain unavailable — fall through to localStorage below.
    }
  }
  ls()?.setItem(KEY_PASSWORD, pw);
}

export async function clearPassword(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_clear_password');
      return;
    } catch {
      // Keychain unavailable — fall through to localStorage below.
    }
  }
  ls()?.removeItem(KEY_PASSWORD);
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(pw: string): Record<string, string> {
  return { Authorization: `Bearer ${pw}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun --cwd apps/mobile test src/secureConfig.web.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun --cwd apps/mobile test`
Expected: `67 pass` (60 existing + 7 new), `0 fail`.

Run: `bun --cwd apps/mobile run lint`
Expected: no errors.

- [ ] **Step 6: Manual on-device verification**

Build and run the desktop app (Linux, per this environment):

```bash
cd apps/mobile
bun run tauri:build
```

or for a faster dev-mode check:

```bash
bun run tauri:dev
```

Once running: go through first-run setup (or Settings) and enter a server password, confirm the app connects. Then:

1. Confirm the password is retrievable via the OS's own keychain tool — on Linux with GNOME Keyring, `secret-tool lookup service tether-desktop username server-password` should print the password (or use `Seahorse` GUI to inspect the "Login" keyring for a `tether-desktop` entry).
2. Restart the app fully (quit, relaunch) and confirm it reconnects without re-prompting for the password (proves `getPassword()` reads it back from the keychain, not a leftover in-memory state).
3. Check `localStorage` is empty for the `tether_password` key — open the app's devtools (if available in this Tauri build) or simply confirm behavior: a fresh `bun run web` (plain browser, no Tauri) run should NOT see the password the desktop app saved (proves it isn't sitting in a shared localStorage that leaked the key).

If step 1's `secret-tool`/keychain lookup fails because no Secret Service daemon is running in this environment, confirm the fallback instead: the app should still work (password saved/read via `localStorage`), proving the fallback path is what's active — not a silent full failure.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/secureConfig.web.ts apps/mobile/src/secureConfig.web.test.ts
git commit -m "feat(desktop): back the password with the OS keychain, localStorage fallback"
```
