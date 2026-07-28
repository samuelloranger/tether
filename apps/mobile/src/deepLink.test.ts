import { expect, test } from 'bun:test';
import { createDeepLinkHandler, parseDeepLink } from './deepLink';
import type { HostProfile } from './tether/hostStore';

const hosts: HostProfile[] = [
  {
    id: 'host-alpha',
    name: 'Alpha',
    color: '#89b4fa',
    host: 'alpha.local',
    port: '8085',
    identityName: 'alpha',
    order: 0,
  },
];

test('parses a tether session link and resolves its host identity', () => {
  expect(parseDeepLink('tether://session/term-7?host=alpha')).toEqual({
    sessionId: 'term-7',
    identityName: 'alpha',
  });
});

test('returns an unknown-host result instead of silently dropping a valid link', () => {
  const handler = createDeepLinkHandler({ getProfiles: () => hosts, onSession: () => {} });

  expect(handler.handle('tether://session/term-7?host=missing')).toEqual({
    kind: 'unknown-host',
    identityName: 'missing',
  });
});

test('rejects malformed URLs without throwing', () => {
  expect(parseDeepLink('https://session/term-7?host=alpha')).toBeNull();
  expect(parseDeepLink('tether://session/?host=alpha')).toBeNull();
  expect(parseDeepLink('tether://session/term-7')).toBeNull();
});

test('queues a link until profiles have loaded, then applies it', () => {
  let profiles: HostProfile[] | null = null;
  const selected: Array<[string, string]> = [];
  const handler = createDeepLinkHandler({
    getProfiles: () => profiles,
    onSession: (hostId, sessionId) => selected.push([hostId, sessionId]),
  });

  expect(handler.handle('tether://session/term-7?host=alpha')).toEqual({ kind: 'queued' });
  profiles = hosts;
  expect(handler.applyPending()).toEqual({
    kind: 'matched',
    hostId: 'host-alpha',
    sessionId: 'term-7',
  });
  expect(selected).toEqual([['host-alpha', 'term-7']]);
});
