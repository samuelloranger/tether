import { expect, test } from 'bun:test';
import {
  createHostStore,
  HOST_PROFILES_KEY,
  type HostProfile,
  type HostStorage,
  LEGACY_PORT_KEY,
  LEGACY_SERVER_IP_KEY,
} from './hostStore';

function memoryStorage(seed: Record<string, string> = {}, failSet = false): HostStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (failSet) throw new Error('disk full');
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

function profile(id: string, order = 0): HostProfile {
  return {
    id,
    name: id,
    color: '#89b4fa',
    host: `${id}.local`,
    port: '8085',
    identityName: id,
    order,
  };
}

test('migrates legacy address and password only after the new profile is readable', async () => {
  const storage = memoryStorage({
    [LEGACY_SERVER_IP_KEY]: 'agent.local',
    [LEGACY_PORT_KEY]: '9000',
  });
  const passwords = new Map([['legacy', 'correct horse battery staple']]);
  const store = createHostStore({
    storage,
    secrets: {
      get: async (id) => passwords.get(id) ?? null,
      set: async (id, password) => void passwords.set(id, password),
      clear: async (id) => void passwords.delete(id),
      getLegacy: async () => passwords.get('legacy') ?? null,
      clearLegacy: async () => void passwords.delete('legacy'),
    },
    makeId: () => 'host-1',
  });

  expect(await store.list()).toEqual([
    {
      id: 'host-1',
      name: 'agent.local',
      color: '#89b4fa',
      host: 'agent.local',
      port: '9000',
      identityName: '',
      order: 0,
    },
  ]);
  expect(await storage.getItem(HOST_PROFILES_KEY)).toContain('host-1');
  expect(await storage.getItem(LEGACY_SERVER_IP_KEY)).toBeNull();
  expect(await storage.getItem(LEGACY_PORT_KEY)).toBeNull();
  expect(passwords.get('host-1')).toBe('correct horse battery staple');
  expect(passwords.get('legacy')).toBeUndefined();
});

test('does not create a profile or consume a password when no legacy address exists', async () => {
  const storage = memoryStorage();
  const passwords = new Map([['legacy', 'orphaned-password']]);
  const store = createHostStore({
    storage,
    secrets: {
      get: async (id) => passwords.get(id) ?? null,
      set: async (id, password) => void passwords.set(id, password),
      clear: async (id) => void passwords.delete(id),
      getLegacy: async () => passwords.get('legacy') ?? null,
      clearLegacy: async () => void passwords.delete('legacy'),
    },
  });

  expect(await store.list()).toEqual([]);
  expect(passwords.get('legacy')).toBe('orphaned-password');
});

test('keeps legacy values when writing the migrated state fails', async () => {
  const storage = memoryStorage(
    { [LEGACY_SERVER_IP_KEY]: 'agent.local', [LEGACY_PORT_KEY]: '8085' },
    true,
  );
  const store = createHostStore({
    storage,
    secrets: {
      get: async () => null,
      set: async () => {},
      clear: async () => {},
      getLegacy: async () => 'legacy-password',
      clearLegacy: async () => {},
    },
    makeId: () => 'host-1',
  });

  await expect(store.list()).rejects.toThrow('disk full');
  expect(await storage.getItem(LEGACY_SERVER_IP_KEY)).toBe('agent.local');
  expect(await storage.getItem(LEGACY_PORT_KEY)).toBe('8085');
});

test('creates, updates, deletes, and reorders profiles with sequential order values', async () => {
  const store = createHostStore({
    storage: memoryStorage(),
    secrets: {
      get: async () => null,
      set: async () => {},
      clear: async () => {},
      getLegacy: async () => null,
      clearLegacy: async () => {},
    },
    makeId: (() => {
      let n = 0;
      return () => `host-${++n}`;
    })(),
  });

  const first = await store.create({ ...profile('ignored'), id: undefined as never });
  const second = await store.create({ ...profile('ignored'), id: undefined as never });
  await store.update(first.id, { name: 'Renamed' });
  await store.reorder([second.id, first.id]);

  expect(await store.list()).toEqual([
    expect.objectContaining({ id: second.id, order: 0 }),
    expect.objectContaining({ id: first.id, name: 'Renamed', order: 1 }),
  ]);
  await store.remove(second.id);
  expect(await store.list()).toEqual([expect.objectContaining({ id: first.id, order: 0 })]);
});
