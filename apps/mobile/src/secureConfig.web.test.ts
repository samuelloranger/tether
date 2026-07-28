import { beforeEach, expect, mock, test } from 'bun:test';

const invoke = mock((_cmd: string, _args?: unknown) => Promise.resolve(undefined));
mock.module('@tauri-apps/api/core', () => ({ invoke }));

let tauriActive = true;
mock.module('./platform', () => ({ isTauri: () => tauriActive }));

const localStorageStub = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    reset: () => {
      store = {};
    },
  };
})();
// @ts-expect-error test-only global stub
globalThis.localStorage = localStorageStub;

const { clearLegacyPassword, clearPassword, getLegacyPassword, getPassword, setPassword } =
  await import('./secureConfig.web');

const HOST_ID = 'host-1';
const HOST_KEY = 'tether_password_host-1';
const FALLBACK_KEY = 'tether_password_host-1_keychain_fallback';
const LEGACY_KEY = 'tether_password';

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve(undefined));
  localStorageStub.reset();
  tauriActive = true;
});

test('uses a distinct keychain entry for each host password', async () => {
  await setPassword(HOST_ID, 'host-password');
  expect(invoke).toHaveBeenCalledWith('secure_set_password', {
    hostId: HOST_ID,
    password: 'host-password',
  });
});

test('gets a host password from its keychain entry', async () => {
  invoke.mockImplementation(() => Promise.resolve('hunter2'));
  await expect(getPassword(HOST_ID)).resolves.toBe('hunter2');
  expect(invoke).toHaveBeenCalledWith('secure_get_password', { hostId: HOST_ID });
});

test('flushes only that host fallback password after a keychain outage', async () => {
  localStorageStub.setItem(FALLBACK_KEY, 'newer-password');
  await expect(getPassword(HOST_ID)).resolves.toBe('newer-password');
  expect(invoke).toHaveBeenCalledWith('secure_set_password', {
    hostId: HOST_ID,
    password: 'newer-password',
  });
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('keeps a host fallback password until the keychain is available', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('locked')));
  localStorageStub.setItem(FALLBACK_KEY, 'pending-password');
  await expect(getPassword(HOST_ID)).resolves.toBe('pending-password');
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBe('pending-password');
});

test('clears both the host keychain credential and its fallback', async () => {
  localStorageStub.setItem(FALLBACK_KEY, 'stale');
  await clearPassword(HOST_ID);
  expect(invoke).toHaveBeenCalledWith('secure_clear_password', { hostId: HOST_ID });
  expect(localStorageStub.getItem(FALLBACK_KEY)).toBeNull();
});

test('uses the host-specific localStorage key in a plain browser preview', async () => {
  tauriActive = false;
  await setPassword(HOST_ID, 'browser-password');
  expect(localStorageStub.getItem(HOST_KEY)).toBe('browser-password');
  await expect(getPassword(HOST_ID)).resolves.toBe('browser-password');
});

test('keeps the legacy credential available only for migration', async () => {
  invoke.mockImplementation(() => Promise.resolve('legacy-password'));
  await expect(getLegacyPassword()).resolves.toBe('legacy-password');
  expect(invoke).toHaveBeenCalledWith('secure_get_legacy_password');
  await clearLegacyPassword();
  expect(invoke).toHaveBeenCalledWith('secure_clear_legacy_password');
});

test('reads and clears the legacy localStorage key only through migration helpers', async () => {
  tauriActive = false;
  localStorageStub.setItem(LEGACY_KEY, 'legacy-password');
  await expect(getLegacyPassword()).resolves.toBe('legacy-password');
  await clearLegacyPassword();
  expect(localStorageStub.getItem(LEGACY_KEY)).toBeNull();
});
