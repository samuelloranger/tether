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
