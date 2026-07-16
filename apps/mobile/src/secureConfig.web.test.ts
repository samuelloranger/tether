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

test('getPassword falls back to localStorage when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no secret service')));
  localStorageStub.setItem('tether_password', 'fallback-pw');
  const pw = await getPassword();
  expect(pw).toBe('fallback-pw');
});

test('setPassword writes to the keychain and clears any stale localStorage entry', async () => {
  localStorageStub.setItem('tether_password', 'old-plaintext');
  await setPassword('new-pw');
  expect(invoke).toHaveBeenCalledWith('secure_set_password', { password: 'new-pw' });
  expect(localStorageStub.getItem('tether_password')).toBeNull();
});

test('setPassword falls back to localStorage when the keychain call throws', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('locked')));
  await setPassword('new-pw');
  expect(localStorageStub.getItem('tether_password')).toBe('new-pw');
});

test('clearPassword calls the Rust command when running under Tauri', async () => {
  await clearPassword();
  expect(invoke).toHaveBeenCalledWith('secure_clear_password');
});

test('non-Tauri (plain browser dev preview) always uses localStorage directly', async () => {
  tauriActive = false;
  await setPassword('browser-pw');
  expect(invoke).not.toHaveBeenCalled();
  expect(localStorageStub.getItem('tether_password')).toBe('browser-pw');
  const pw = await getPassword();
  expect(pw).toBe('browser-pw');
});
