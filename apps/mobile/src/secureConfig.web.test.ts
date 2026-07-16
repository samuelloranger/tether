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

test('getPassword calls the Rust keychain command when there is no pending fallback', async () => {
  invoke.mockImplementation(() => Promise.resolve('hunter2'));
  const pw = await getPassword();
  expect(invoke).toHaveBeenCalledWith('secure_get_password');
  expect(pw).toBe('hunter2');
});

test('getPassword returns null when the keychain throws and there is no pending fallback', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no secret service')));
  const pw = await getPassword();
  expect(pw).toBeNull();
});

test('getPassword under Tauri never returns a leftover legacy plaintext password, even if the keychain is empty', async () => {
  // Regression for codex P1: an existing desktop user upgrading has an old
  // plaintext password sitting under the legacy key, no fallback entry, and
  // an empty keychain. This must NOT silently resurrect the legacy value —
  // the user re-enters it once, per the no-migration product decision.
  invoke.mockImplementation(() => Promise.resolve(null));
  localStorageStub.setItem(LEGACY_KEY, 'old-plaintext-from-before-upgrade');
  const pw = await getPassword();
  expect(pw).toBeNull();
});

test('getPassword flushes a pending fallback into the keychain once it is reachable again, and the newer value wins', async () => {
  // Regression for codex P2 (2nd round): the keychain already holds an OLDER
  // password. A newer one was saved to the fallback key during an outage.
  // Once the keychain is reachable again, the newer fallback value must win
  // and get synced — not the stale keychain value.
  invoke.mockImplementation((cmd: string) =>
    cmd === 'secure_get_password' ? Promise.resolve('old-keychain-pw') : Promise.resolve(undefined),
  );
  localStorageStub.setItem(FALLBACK_KEY, 'newer-pw-saved-during-outage');
  const pw = await getPassword();
  expect(invoke).toHaveBeenCalledWith('secure_set_password', { password: 'newer-pw-saved-during-outage' });
  expect(pw).toBe('newer-pw-saved-during-outage');
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('getPassword keeps using a pending fallback value while the keychain is still unavailable', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('still locked')));
  localStorageStub.setItem(FALLBACK_KEY, 'pending-pw');
  const pw = await getPassword();
  expect(pw).toBe('pending-pw');
  // Not yet synced — must stay put so the next read/attempt can retry.
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBe('pending-pw');
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
