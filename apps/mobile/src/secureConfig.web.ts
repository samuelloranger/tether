import { isTauri } from './platform';

const LEGACY_PASSWORD_KEY = 'tether_password';

export function passwordKey(hostId: string): string {
  return `tether_password_${hostId}`;
}

function fallbackKey(hostId: string): string {
  return `${passwordKey(hostId)}_keychain_fallback`;
}

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export async function getPassword(hostId: string): Promise<string | null> {
  if (!isTauri()) return ls()?.getItem(passwordKey(hostId)) ?? null;
  const pending = ls()?.getItem(fallbackKey(hostId)) ?? null;
  if (pending !== null) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_set_password', { hostId, password: pending });
      ls()?.removeItem(fallbackKey(hostId));
    } catch {
      // Keep the newest value until the OS keychain is available again.
    }
    return pending;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('secure_get_password', { hostId });
  } catch {
    return null;
  }
}

export async function setPassword(hostId: string, password: string): Promise<void> {
  if (!isTauri()) {
    ls()?.setItem(passwordKey(hostId), password);
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('secure_set_password', { hostId, password });
    ls()?.removeItem(fallbackKey(hostId));
  } catch {
    ls()?.setItem(fallbackKey(hostId), password);
  }
}

export async function clearPassword(hostId: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_clear_password', { hostId });
    } catch {
      // The fallback entry must still be cleared even if the keychain is down.
    }
    ls()?.removeItem(fallbackKey(hostId));
    return;
  }
  ls()?.removeItem(passwordKey(hostId));
}

// Migration-only access to the old single desktop credential/localStorage key.
export async function getLegacyPassword(): Promise<string | null> {
  if (!isTauri()) return ls()?.getItem(LEGACY_PASSWORD_KEY) ?? null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('secure_get_legacy_password');
  } catch {
    return null;
  }
}

export async function clearLegacyPassword(): Promise<void> {
  if (!isTauri()) {
    ls()?.removeItem(LEGACY_PASSWORD_KEY);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('secure_clear_legacy_password');
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(password: string): Record<string, string> {
  return { Authorization: `Bearer ${password}` };
}
