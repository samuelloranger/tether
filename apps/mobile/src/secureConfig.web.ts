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
      const pw = await invoke<string | null>('secure_get_password');
      if (pw !== null) {
        // Keychain has it — drop any stale fallback copy from an earlier outage.
        ls()?.removeItem(KEY_PASSWORD);
        return pw;
      }
      // Keychain reachable but empty — a value saved locally during a prior
      // outage (setPassword's fallback path) is still valid; don't force the
      // user to re-enter it just because the keychain is back.
      return ls()?.getItem(KEY_PASSWORD) ?? null;
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
      // Also drop any stale fallback copy, or a later keychain outage could
      // resurrect a password this call just cleared.
      ls()?.removeItem(KEY_PASSWORD);
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
