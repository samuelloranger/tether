export const HOST_PROFILES_KEY = 'tether_host_profiles';
export const LEGACY_SERVER_IP_KEY = 'tether_server_ip';
export const LEGACY_PORT_KEY = 'tether_port';

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
  getLegacy(): Promise<string | null>;
  clearLegacy(): Promise<void>;
}

export interface HostStore {
  list(): Promise<HostProfile[]>;
  create(profile: Omit<HostProfile, 'id' | 'order'>): Promise<HostProfile>;
  update(id: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>): Promise<HostProfile>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<HostProfile[]>;
}

type Dependencies = {
  storage: HostStorage;
  secrets: HostSecrets;
  makeId?: () => string;
};

const DEFAULT_COLOR = '#89b4fa';

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

export function createHostStore({
  storage,
  secrets,
  makeId = createHostId,
}: Dependencies): HostStore {
  const read = async () => parseProfiles(await storage.getItem(HOST_PROFILES_KEY));
  const write = async (profiles: HostProfile[]) => {
    await storage.setItem(HOST_PROFILES_KEY, JSON.stringify(ordered(profiles)));
  };

  const migrate = async (profiles: HostProfile[]): Promise<HostProfile[]> => {
    const legacyHost = await storage.getItem(LEGACY_SERVER_IP_KEY);
    if (!legacyHost) return profiles;

    const legacyPort = (await storage.getItem(LEGACY_PORT_KEY)) || '8085';
    let profile = profiles.find(
      (candidate) => candidate.host === legacyHost && candidate.port === legacyPort,
    );
    if (!profile) {
      profile = {
        id: makeId(),
        name: legacyHost,
        color: DEFAULT_COLOR,
        host: legacyHost,
        port: legacyPort,
        identityName: '',
        order: profiles.length,
      };
      profiles = [...profiles, profile];
      await write(profiles);
    }

    const legacyPassword = await secrets.getLegacy();
    if (legacyPassword !== null) {
      await secrets.set(profile.id, legacyPassword);
      if ((await secrets.get(profile.id)) !== legacyPassword) {
        throw new Error('Migrated host password could not be read back');
      }
    }
    const reread = await read();
    if (!reread.some((candidate) => candidate.id === profile.id)) {
      throw new Error('Migrated host profile could not be read back');
    }

    // New state is durable. Cleanup is intentionally best-effort: if interrupted,
    // the next launch re-verifies this same profile before attempting cleanup again.
    await Promise.all([
      storage.removeItem(LEGACY_SERVER_IP_KEY).catch(() => {}),
      storage.removeItem(LEGACY_PORT_KEY).catch(() => {}),
      secrets.clearLegacy().catch(() => {}),
    ]);
    return reread;
  };

  const list = async () => migrate(await read());

  return {
    list,
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
