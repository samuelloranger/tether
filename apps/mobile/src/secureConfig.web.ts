// Web build: expo-secure-store has no web implementation, so back the password
// in localStorage. Metro resolves this file (over secureConfig.ts) on web.
// Same interface as the native module. Note: localStorage is not encrypted —
// on the desktop/web client the OS keychain isn't available; the tunnel + the
// server password remain the security boundary.
const KEY_PASSWORD = 'tether_password';

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export async function getPassword(): Promise<string | null> {
  return ls()?.getItem(KEY_PASSWORD) ?? null;
}

export async function setPassword(pw: string): Promise<void> {
  ls()?.setItem(KEY_PASSWORD, pw);
}

export async function clearPassword(): Promise<void> {
  ls()?.removeItem(KEY_PASSWORD);
}

// Attach the shared password to every request. Secret rides the header, never the URL.
export function authHeaders(pw: string): Record<string, string> {
  return { Authorization: `Bearer ${pw}` };
}
