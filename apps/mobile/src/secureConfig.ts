import * as SecureStore from 'expo-secure-store';

const LEGACY_PASSWORD_KEY = 'tether_password';

export function passwordKey(hostId: string): string {
  return `tether_password_${hostId}`;
}

export async function getPassword(hostId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(passwordKey(hostId));
  } catch {
    return null;
  }
}

export async function setPassword(hostId: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(passwordKey(hostId), password);
}

export async function clearPassword(hostId: string): Promise<void> {
  await SecureStore.deleteItemAsync(passwordKey(hostId));
}

// The AES-GCM key this device shares with the Tether servers it registers
// with. One key per device (not per host) — every server encrypts with it, and
// the Notification Service Extension needs a single key to decrypt whatever
// arrives. Lives in the Keychain, and the extension reads it from the shared
// access group rather than being handed a copy.
const PUSH_KEY = 'tether_push_secret';

// SecureStore defaults to WHEN_UNLOCKED, which would make this key unreadable
// exactly when it matters: a notification arriving on a locked phone. The
// service extension would then fail to decrypt and every push would show the
// generic fallback. AFTER_FIRST_UNLOCK keeps it readable once the device has
// been unlocked at least once since boot; THIS_DEVICE_ONLY keeps it out of
// backups and off other devices, which suits a per-device key.
const PUSH_KEY_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} as const;

export async function getPushSecret(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PUSH_KEY, PUSH_KEY_OPTIONS);
  } catch {
    return null;
  }
}

export async function setPushSecret(secret: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_KEY, secret, PUSH_KEY_OPTIONS);
}

/**
 * Rewrite an existing key with the accessibility above.
 *
 * Keys written by an earlier build are stuck at WHEN_UNLOCKED, and there is no
 * way to read an item's accessibility class to detect that — so the only
 * reliable migration is an unconditional rewrite. Idempotent and cheap; runs
 * once per app launch alongside registration.
 */
export async function migratePushSecretAccessibility(secret: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(PUSH_KEY, secret, PUSH_KEY_OPTIONS);
  } catch {
    // Non-fatal: worst case the key keeps its old accessibility and locked-phone
    // pushes fall back to the generic text.
  }
}

// Migration-only access to the pre-multi-host SecureStore entry. New callers
// must always use a host id through the functions above.
export async function getLegacyPassword(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LEGACY_PASSWORD_KEY);
  } catch {
    return null;
  }
}

export async function clearLegacyPassword(): Promise<void> {
  await SecureStore.deleteItemAsync(LEGACY_PASSWORD_KEY);
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(pw: string): Record<string, string> {
  return { Authorization: `Bearer ${pw}` };
}
