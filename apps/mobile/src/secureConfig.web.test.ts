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

const LEGACY_KEY = 'tether_password';
const FALLBACK_KEY = 'tether_password_keychain_fallback';

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

test('getPassword falls back to the fallback key when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no secret service')));
  localStorageStub.setItem(FALLBACK_KEY, 'fallback-pw');
  const pw = await getPassword();
  expect(pw).toBe('fallback-pw');
});

test('getPassword returns a fallback value when the keychain is reachable but empty', async () => {
  // Simulates: password was saved during a keychain outage (setPassword's
  // catch path), and the keychain has since recovered but has no entry.
  invoke.mockImplementation(() => Promise.resolve(null));
  localStorageStub.setItem(FALLBACK_KEY, 'saved-during-outage');
  const pw = await getPassword();
  expect(pw).toBe('saved-during-outage');
});

test('getPassword clears a stale fallback value once the keychain has a real value', async () => {
  invoke.mockImplementation(() => Promise.resolve('hunter2'));
  localStorageStub.setItem(FALLBACK_KEY, 'stale-fallback');
  const pw = await getPassword();
  expect(pw).toBe('hunter2');
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('getPassword under Tauri never returns a leftover legacy plaintext password, even if the keychain is empty', async () => {
  // Regression for codex P1: an existing desktop user upgrading has an old
  // plaintext password sitting under the legacy key. The keychain is empty
  // (nothing saved there yet) and there is no fallback-key entry either —
  // this must NOT silently resurrect the legacy value; the user re-enters it.
  invoke.mockImplementation(() => Promise.resolve(null));
  localStorageStub.setItem(LEGACY_KEY, 'old-plaintext-from-before-upgrade');
  const pw = await getPassword();
  expect(pw).toBeNull();
});

test('setPassword writes to the keychain and clears both the fallback and legacy keys', async () => {
  localStorageStub.setItem(LEGACY_KEY, 'old-plaintext');
  localStorageStub.setItem(FALLBACK_KEY, 'stale-fallback');
  await setPassword('new-pw');
  expect(invoke).toHaveBeenCalledWith('secure_set_password', { password: 'new-pw' });
  expect(localStorageStub.getItem(LEGACY_KEY)).toBeNull();
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('setPassword falls back to the fallback key when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('locked')));
  await setPassword('new-pw');
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBe('new-pw');
});

test('clearPassword calls the Rust command when running under Tauri', async () => {
  await clearPassword();
  expect(invoke).toHaveBeenCalledWith('secure_clear_password');
});

test('clearPassword also clears a stale fallback value so it cannot resurrect later', async () => {
  localStorageStub.setItem(FALLBACK_KEY, 'stale-fallback');
  await clearPassword();
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('non-Tauri (plain browser dev preview) always uses the legacy key directly', async () => {
  tauriActive = false;
  await setPassword('browser-pw');
  expect(invoke).not.toHaveBeenCalled();
  expect(localStorageStub.getItem(LEGACY_KEY)).toBe('browser-pw');
  const pw = await getPassword();
  expect(pw).toBe('browser-pw');
});
