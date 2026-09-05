export type PairScheme = 'http' | 'https';

const STORAGE_KEY = 'tether.host.schemes';

function load(): Record<string, PairScheme> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, PairScheme>;
  } catch {
    return {};
  }
}

function save(map: Record<string, PairScheme>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function recordHostScheme(hostId: string, scheme: PairScheme): void {
  const map = load();
  map[hostId] = scheme;
  save(map);
}

export function forgetHostScheme(hostId: string): void {
  const map = load();
  delete map[hostId];
  save(map);
}

export function hostScheme(hostId: string, port: string): PairScheme {
  const recorded = load()[hostId];
  if (recorded) return recorded;
  if (port === '443' || port === '8443') return 'https';
  return 'http';
}
