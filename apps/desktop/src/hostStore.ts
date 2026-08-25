export const HOST_PROFILES_KEY = 'tether_host_profiles';
export const KEY_ACTIVE_HOST = 'tether_active_host';

export interface HostProfile {
  id: string;
  name: string;
  color: string;
  host: string;
  port: string;
  identityName: string;
  order: number;
}

export interface HostStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface HostSecrets {
  get(hostId: string): Promise<string | null>;
  set(hostId: string, password: string): Promise<void>;
  clear(hostId: string): Promise<void>;
}

export interface HostStore {
  list(): Promise<HostProfile[]>;
  create(profile: Omit<HostProfile, 'id' | 'order'>): Promise<HostProfile>;
  update(id: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>): Promise<HostProfile>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<HostProfile[]>;
}

export function createHostId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const value = (Math.random() * 16) | 0;
    const nibble = character === 'x' ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function ordered(profiles: HostProfile[]): HostProfile[] {
  return [...profiles].sort((left, right) => left.order - right.order);
}

function parseProfiles(value: string | null): HostProfile[] {
  if (!value) return [];
  try {
    const profiles = JSON.parse(value) as unknown;
    if (!Array.isArray(profiles)) return [];
    return ordered(
      profiles.filter(
        (profile): profile is HostProfile =>
          typeof profile === 'object' &&
          profile !== null &&
          typeof profile.id === 'string' &&
          typeof profile.name === 'string' &&
          typeof profile.color === 'string' &&
          typeof profile.host === 'string' &&
          typeof profile.port === 'string' &&
          typeof profile.identityName === 'string' &&
          typeof profile.order === 'number',
      ),
    );
  } catch {
    return [];
  }
}

function bindHostMutations(
  list: () => Promise<HostProfile[]>,
  write: (profiles: HostProfile[]) => Promise<void>,
  makeId: () => string,
  secrets: HostSecrets,
): Omit<HostStore, 'list'> {
  return {
    async create(input) {
      const profiles = await list();
      const profile: HostProfile = {
        ...input,
        id: makeId(),
        order: profiles.length,
      };
      await write([...profiles, profile]);
      return profile;
    },
    async update(id, changes) {
      const profiles = await list();
      const current = profiles.find((profile) => profile.id === id);
      if (!current) throw new Error(`Unknown host profile: ${id}`);
      const next = { ...current, ...changes };
      await write(profiles.map((profile) => (profile.id === id ? next : profile)));
      return next;
    },
    async remove(id) {
      const profiles = await list();
      if (!profiles.some((profile) => profile.id === id)) return;
      await secrets.clear(id);
      await write(
        profiles
          .filter((profile) => profile.id !== id)
          .map((profile, order) => ({ ...profile, order })),
      );
    },
    async reorder(ids) {
      const profiles = await list();
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      const requested = ids.flatMap((id) => {
        const profile = byId.get(id);
        return profile ? [profile] : [];
      });
      const remaining = profiles.filter((profile) => !ids.includes(profile.id));
      const next = [...requested, ...remaining].map((profile, order) => ({ ...profile, order }));
      await write(next);
      return next;
    },
  };
}

export function createHostStore({
  storage,
  secrets,
  makeId = createHostId,
}: {
  storage: HostStorage;
  secrets: HostSecrets;
  makeId?: () => string;
}): HostStore {
  const write = async (profiles: HostProfile[]) => {
    await storage.setItem(HOST_PROFILES_KEY, JSON.stringify(ordered(profiles)));
  };
  const list = async () => parseProfiles(await storage.getItem(HOST_PROFILES_KEY));
  return { list, ...bindHostMutations(list, write, makeId, secrets) };
}

export function activeSessionStorageKey(hostId: string): string {
  return `tether_session_id_${hostId}`;
}

const browserStorage: HostStorage = {
  getItem: async (key) => localStorage.getItem(key),
  setItem: async (key, value) => {
    localStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    localStorage.removeItem(key);
  },
};

export function createDefaultHostStore(secrets: HostSecrets): HostStore {
  return createHostStore({ storage: browserStorage, secrets });
}
