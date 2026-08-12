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

export async function getPushSecret(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PUSH_KEY);
  } catch {
    return null;
  }
}

export async function setPushSecret(secret: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_KEY, secret);
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
