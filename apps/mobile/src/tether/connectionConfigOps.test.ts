import { expect, mock, test } from 'bun:test';
import type { TestStatus } from './connectionConfigLogic';
import type { HostClient } from './hostClient';

// connectionConfigOps reaches AsyncStorage, ../dialog (react-native) and
// ../secureConfig; mock them so the module can be imported under bun:test.
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Alert: { alert: () => {} },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
mock.module('../secureConfig', () => ({
  passwordKey: (hostId: string) => `tether_password_${hostId}`,
  getPassword: async () => '',
  setPassword: async () => {},
  clearPassword: async () => {},
  getLegacyPassword: async () => null,
  clearLegacyPassword: async () => {},
  authHeaders: (pw: string) => ({ Authorization: `Bearer ${pw}` }),
}));

const { runTestConnection } = await import('./connectionConfigOps');

function harness(serverIp: string, port: string) {
  const statuses: TestStatus[] = [];
  const requested: string[] = [];
  const s = {
    setTestStatus: (status: TestStatus) => statuses.push(status),
    setSetupMode: () => {},
    setDiscoveredIdentity: () => {},
  };
  const client = {
    get: async (path: string) => {
      requested.push(path);
      return new Response(JSON.stringify({ needsSetup: false }));
    },
  } as unknown as HostClient;
  return {
    statuses,
    requested,
    run: () =>
      runTestConnection({
        s: s as unknown as Parameters<typeof runTestConnection>[0]['s'],
        client,
        serverIp,
        port,
        password: 'pw',
        confirmPassword: 'pw',
      }),
  };
}

// Regression: validateAddress moved behind an await (into testServerConnection),
// so 'testing' was committed first and the spinner flashed before the error.
test('a malformed address errors without ever entering the testing state', async () => {
  const h = harness('my-host.local', '99999');
  await h.run();
  expect(h.statuses.map((status) => status.kind)).toEqual(['error']);
  expect(h.requested).toEqual([]);
});

test('an empty host errors without entering the testing state', async () => {
  const h = harness('', '8085');
  await h.run();
  expect(h.statuses.map((status) => status.kind)).toEqual(['error']);
  expect(h.requested).toEqual([]);
});

test('a valid address shows the spinner before reaching the server', async () => {
  const h = harness('my-host.local', '8085');
  await h.run();
  expect(h.statuses[0]?.kind).toBe('testing');
  expect(h.requested[0]).toBe('/api/status');
});
