const LEGACY_PASSWORD_KEY = 'tether_password';

export function passwordKey(hostId: string): string {
  return `tether_password_${hostId}`;
}

function fallbackKey(hostId: string): string {
  return `${passwordKey(hostId)}_keychain_fallback`;
}

export async function getPassword(hostId: string): Promise<string | null> {
  const pending = localStorage.getItem(fallbackKey(hostId));
  if (pending !== null) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_set_password', { hostId, password: pending });
      localStorage.removeItem(fallbackKey(hostId));
    } catch {
      return pending;
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
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('secure_set_password', { hostId, password });
    localStorage.removeItem(fallbackKey(hostId));
  } catch {
    localStorage.setItem(fallbackKey(hostId), password);
  }
}

export async function clearPassword(hostId: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('secure_clear_password', { hostId });
  } catch {
    // fall through
  }
  localStorage.removeItem(fallbackKey(hostId));
}

export async function getLegacyPassword(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('secure_get_legacy_password');
  } catch {
    return localStorage.getItem(LEGACY_PASSWORD_KEY);
  }
}

export async function clearLegacyPassword(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('secure_clear_legacy_password');
  } catch {
    // fall through
  }
  localStorage.removeItem(LEGACY_PASSWORD_KEY);
}

export const hostSecrets = {
  get: getPassword,
  set: setPassword,
  clear: clearPassword,
  getLegacy: getLegacyPassword,
  clearLegacy: clearLegacyPassword,
};

export function authHeaders(password: string): Record<string, string> {
  return { Authorization: `Bearer ${password}` };
}
