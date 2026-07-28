import type { HostProfile } from './tether/hostStore';

export type SessionDeepLink = { sessionId: string; identityName: string };

export type DeepLinkResult =
  | { kind: 'matched'; hostId: string; sessionId: string }
  | { kind: 'unknown-host'; identityName: string }
  | { kind: 'invalid' }
  | { kind: 'queued' };

export function parseDeepLink(url: string): SessionDeepLink | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'tether:' || parsed.hostname !== 'session') return null;
    const sessionId = parsed.pathname.replace(/^\//, '');
    const identityName = parsed.searchParams.get('host');
    if (!sessionId || !identityName) return null;
    return { sessionId, identityName };
  } catch {
    return null;
  }
}

export function createDeepLinkHandler({
  getProfiles,
  onSession,
}: {
  getProfiles: () => HostProfile[] | null;
  onSession: (hostId: string, sessionId: string) => void;
}) {
  let pending: string | null = null;

  const resolve = (url: string): DeepLinkResult => {
    const link = parseDeepLink(url);
    if (!link) return { kind: 'invalid' };
    const profiles = getProfiles();
    if (profiles === null) {
      pending = url;
      return { kind: 'queued' };
    }
    const profile = profiles.find((candidate) => candidate.identityName === link.identityName);
    if (!profile) return { kind: 'unknown-host', identityName: link.identityName };
    onSession(profile.id, link.sessionId);
    return { kind: 'matched', hostId: profile.id, sessionId: link.sessionId };
  };

  return {
    handle: resolve,
    applyPending(): DeepLinkResult | null {
      if (!pending || getProfiles() === null) return null;
      const url = pending;
      pending = null;
      return resolve(url);
    },
  };
}
