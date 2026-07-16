# Native secret store for desktop password

## Goal

Stop storing the Tether server password in plaintext `localStorage` on desktop. Move it to the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) via a Rust command, with a `localStorage` fallback for when the OS keychain is unavailable.

## Design

### Rust side (`apps/mobile/src-tauri`)

Add the `keyring` crate (`Cargo.toml`) and three `#[tauri::command]`s in `main.rs`, following the exact pattern already used by `ws_connect`/`ws_send`/`ws_close`/`is_updatable`:

```rust
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("tether-desktop", "server-password").map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_get_password() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secure_set_password(password: String) -> Result<(), String> {
    entry()?.set_password(&password).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_clear_password() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

`keyring::Error::NoEntry` (nothing saved yet) maps to `Ok(None)`/`Ok(())`, not an error — a fresh install with no saved password is a normal state.

Registered in `invoke_handler![...]` alongside the existing commands. No new Tauri plugin — the `keyring` crate is used directly, since it already handles all three OS backends and is far more widely used/audited than a community `tauri-plugin-keyring`. Tauri's official Stronghold plugin was considered and rejected: it's a separate encrypted vault requiring its own master password, which doesn't fit a single shared-secret use case like this.

### TypeScript side (`apps/mobile/src`)

`isTauri()` (currently defined and exported only from `wsTransport.ts`, checking the injected `__TAURI_INTERNALS__` global) moves to `platform.ts`, alongside `isDesktop`/`isMacDesktop` — it's genuinely a platform-detection helper, not transport-specific, and now has a second consumer. `wsTransport.ts` imports it from `platform.ts` instead of defining it.

`secureConfig.web.ts` keeps its existing exported interface (`getPassword`/`setPassword`/`clearPassword`/`authHeaders`) unchanged so no caller (`useTetherApp.tsx`, etc.) needs to change. Internally:

```typescript
export async function getPassword(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('secure_get_password');
    } catch {
      // Keychain unavailable (e.g. no Secret Service daemon on a minimal Linux
      // desktop) — fall through to the localStorage path below.
    }
  }
  return ls()?.getItem(KEY_PASSWORD) ?? null;
}
```

`setPassword`/`clearPassword` follow the same shape: try the Rust command when `isTauri()`, fall back to `localStorage` on any thrown error. `setPassword` additionally clears any stale `localStorage` entry once the keychain write succeeds, so an old plaintext copy doesn't linger — but never reads it. Per product decision, there is no migration: existing desktop users re-enter their password once after upgrading; from then on it lives only in the keychain (or in `localStorage` if the keychain path isn't available on that machine).

When not running under Tauri (`isTauri()` false — the plain-browser `bun run web` dev preview), behavior is unchanged: `localStorage` directly, same as today.

`secureConfig.ts` (native iOS/Android, backed by `expo-secure-store`) is untouched — this work is desktop-only.

## Error handling and testing

- Any Rust-side keyring failure (locked keychain, no Secret Service daemon, permission denied) is caught in TS and falls back to `localStorage` — behavior never regresses versus today.
- `NoEntry` on `get`/`clear` is a normal empty state, not surfaced as an error to the caller.
- New `apps/mobile/src/secureConfig.web.test.ts`, mocking `isTauri()` and the dynamic `@tauri-apps/api/core` import, covering: keychain success path (get/set/clear round-trip), keychain-failure → `localStorage` fallback, and the non-Tauri plain-browser path.
- No Rust-side automated test (this repo has no Rust test infra — `ws_connect` etc. aren't tested either). Manually verify the get/set/clear round-trip on a real Linux desktop build during implementation.
