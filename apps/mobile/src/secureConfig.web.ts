// Web build: on the Tauri desktop shell, the password lives in the OS keychain
// (Rust `keyring` crate, invoked via secure_get_password/secure_set_password/
// secure_clear_password — see apps/mobile/src-tauri/src/main.rs). Falls back to
// localStorage when the keychain call fails (e.g. no Secret Service daemon on a
// minimal Linux desktop) or when running the plain-browser `bun run web` dev
// preview, which has no Rust backend to invoke at all. Same interface as the
// native module (secureConfig.ts); Metro resolves this file over it on web.
import { isTauri } from './platform';

// Legacy key, from before the keychain existed. Read only on the non-Tauri
// (plain-browser dev preview) path below — once Tauri/the keychain is active,
// this is intentionally never read, only opportunistically deleted, so an
// existing desktop user's old plaintext password isn't silently reused
// forever (per product decision: re-enter once, then it's keychain-only).
const KEY_PASSWORD = 'tether_password';

// Distinct key for values saved *by this feature's own fallback path*, when
// the keychain call itself fails (e.g. no Secret Service daemon running).
// Kept separate from KEY_PASSWORD so a transient outage's fallback value
// isn't confused with the legacy pre-keychain plaintext password above.
const KEY_PASSWORD_FALLBACK = 'tether_password_keychain_fallback';

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export async function getPassword(): Promise<string | null> {
  if (isTauri()) {
    // A fallback value exists ONLY because a previous setPassword's keychain
    // write failed — it is therefore always more recent than whatever's
    // already in the keychain (which wasn't updated during that outage).
    // Try to flush it now, on every read, so a recovered keychain gets synced
    // instead of a stale keychain value silently winning and the newer
    // fallback password being discarded.
    const pending = ls()?.getItem(KEY_PASSWORD_FALLBACK) ?? null;
    if (pending !== null) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('secure_set_password', { password: pending });
        ls()?.removeItem(KEY_PASSWORD_FALLBACK);
        ls()?.removeItem(KEY_PASSWORD);
      } catch {
        // Keychain still unavailable — keep using the pending value below.
      }
      return pending;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('secure_get_password');
    } catch {
      return null;
    }
  }
  return ls()?.getItem(KEY_PASSWORD) ?? null;
}

export async function setPassword(pw: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_set_password', { password: pw });
      // Keychain write succeeded — clear both the outage-fallback copy and
      // any leftover legacy plaintext copy from before this feature shipped.
      ls()?.removeItem(KEY_PASSWORD_FALLBACK);
      ls()?.removeItem(KEY_PASSWORD);
      return;
    } catch {
      // Keychain unavailable — save under the dedicated fallback key so it's
      // never confused with (or mistaken for a migration of) legacy data.
      ls()?.setItem(KEY_PASSWORD_FALLBACK, pw);
      return;
    }
  }
  ls()?.setItem(KEY_PASSWORD, pw);
}

export async function clearPassword(): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_clear_password');
    } catch {
      // Keychain unavailable — still clear the fallback key below so a
      // subsequent outage can't resurrect an already-cleared password.
    }
    ls()?.removeItem(KEY_PASSWORD_FALLBACK);
    return;
  }
  ls()?.removeItem(KEY_PASSWORD);
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(pw: string): Record<string, string> {
  return { Authorization: `Bearer ${pw}` };
}
