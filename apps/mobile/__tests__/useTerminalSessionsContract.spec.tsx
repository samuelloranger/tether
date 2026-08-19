import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { HostClient } from '../src/tether/hostClient';
import type { HostProfile } from '../src/tether/hostStore';
import { useTerminalSessions } from '../src/tether/useTerminalSessions';

// Characterization tests: these pin the observable contract of the composed
// hook — the public surface, initial state, and the wiring between host polling
// and the state the UI renders — so the hook's internals can be restructured
// without silently changing what App.tsx sees.

type Polling = {
  options: {
    onHealth(profile: HostProfile, result: 'success' | 'failure' | 'unauthorized'): void;
    onSessions(profile: HostProfile, sessions: unknown[]): void;
    getActiveHostId(): string;
  };
  start: jest.Mock;
  stop: jest.Mock;
};

const pollings: Polling[] = [];

jest.mock('../src/terminalEngine', () => ({
  TerminalEngine: jest.fn(() => ({
    onReply: null,
    onClipboardWrite: null,
    serialize: () => '',
    reset: () => {},
    write: () => {},
    cols: 80,
    rows: 24,
  })),
}));

jest.mock('../src/tether/hostPolling', () => ({
  createHostPolling: jest.fn((options) => {
    const polling = { options, start: jest.fn(async () => {}), stop: jest.fn() };
    pollings.push(polling);
    return polling;
  }),
}));

const profile: HostProfile = {
  id: 'host-alpha',
  name: 'Alpha',
  color: '#89b4fa',
  host: 'alpha.local',
  port: '8085',
  identityName: 'alpha',
  order: 0,
};
const theme = { terminal: { fg: '#cdd6f4', bg: '#1e1e2e' }, keyboardAppearance: 'dark' as const };

function makeClient(target: HostProfile = profile): HostClient {
  return {
    profile: target,
    get: jest.fn(async () => new Response('{}')),
    post: jest.fn(async () => new Response('{}')),
    url: jest.fn(() => ''),
    authHeader: {},
    openSocket: jest.fn(),
    loadIdentity: jest.fn(),
    baseUrl: `http://${target.host}:${target.port}`,
  } as unknown as HostClient;
}

type Api = ReturnType<typeof useTerminalSessions>;

function mount(overrides: { profiles?: HostProfile[]; ready?: boolean } = {}) {
  const client = makeClient();
  // Hoisted so their identity is stable across re-renders, matching production
  // (profiles is state and clientFor is a useCallback in useConnectionConfig).
  // Rebuilding them per render would restart host polling for reasons that have
  // nothing to do with the hook under test.
  const profiles = overrides.profiles ?? [profile];
  const clientFor = () => client;
  const seen: { api: Api | null; closes: number; clears: number } = {
    api: null,
    closes: 0,
    clears: 0,
  };
  function Probe(_props: { unrelated?: number }) {
    seen.api = useTerminalSessions({
      client,
      profiles,
      clientFor,
      ready: overrides.ready ?? false,
      isConfiguring: false,
      theme,
      fontFamily: 'monospace',
      fontSize: 14,
      notificationsEnabledRef: { current: false },
      onClearView: () => seen.clears++,
      onClearPresentation: () => {},
      onCloseDrawer: () => seen.closes++,
    });
    return <Text>probe</Text>;
  }
  const view = render(<Probe />);
  const api = () => {
    if (!seen.api) throw new Error('hook did not render');
    return seen.api;
  };
  return { view, api, seen, Probe };
}

beforeEach(() => {
  pollings.length = 0;
});

test('exposes a stable public surface', () => {
  const { api } = mount();
  // Locked deliberately: App.tsx and the tether facade destructure these by
  // name, so adding is safe but renaming or dropping one is a breaking change.
  expect(Object.keys(api()).sort()).toEqual(
    [
      'activeClient',
      'activeHostId',
      'activeId',
      'connectionStatus',
      'drawerSessions',
      'entryFor',
      'getActiveSessionId',
      'getSessionEntry',
      'getTerminalSelection',
      'hasConnected',
      'healthByHost',
      'hydrateRenderer',
      'isWindowFocused',
      'killActiveOr',
      'markAuthFailed',
      'newTerminal',
      'onPageClipboardWrite',
      'onPageControl',
      'onPageReply',
      'onRendererResize',
      'onRendererSelection',
      'refreshHost',
      'refreshSessions',
      'refreshSocketActivity',
      'removeHost',
      'resetForEndpointChange',
      'resetHostHealth',
      'resetTerminal',
      'restartActiveSession',
      'setWindowFocused',
      'switchTo',
      'terminalViewRef',
      'wsSend',
    ].sort(),
  );
});

test('starts on term-1 of the supplied client profile', () => {
  const { api } = mount();
  expect(api().activeId).toBe('term-1');
  expect(api().activeHostId).toBe('host-alpha');
  expect(api().connectionStatus).toBe('disconnected');
  expect(api().hasConnected).toBe(false);
  expect(api().drawerSessions).toEqual([]);
  expect(api().getActiveSessionId()).toBe('term-1');
});

test('polled sessions become drawer sessions', async () => {
  const { api } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  await act(async () => {
    pollings[0]?.options.onSessions(profile, [
      { id: 'term-1', status: 'running', last_output_at: null },
      { id: 'term-2', status: 'running', last_output_at: null },
    ]);
  });
  expect(api().drawerSessions.map((row) => row.id)).toEqual(['term-1', 'term-2']);
  expect(api().drawerSessions.every((row) => row.hostId === 'host-alpha')).toBe(true);
});

test('health results land in healthByHost', async () => {
  const { api } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  await act(async () => {
    pollings[0]?.options.onHealth(profile, 'success');
  });
  expect(api().healthByHost['host-alpha']).toBe('reachable');
  await act(async () => {
    pollings[0]?.options.onHealth(profile, 'unauthorized');
  });
  expect(api().healthByHost['host-alpha']).toBe('unauthorized');
});

test('resetHostHealth returns a host to unknown', async () => {
  const { api } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  await act(async () => {
    pollings[0]?.options.onHealth(profile, 'success');
  });
  await act(async () => {
    api().resetHostHealth('host-alpha');
  });
  expect(api().healthByHost['host-alpha']).toBe('unknown');
});

test('switchTo moves the active session and closes the drawer', async () => {
  const { api, seen } = mount();
  await act(async () => {
    api().switchTo('host-alpha', 'term-4');
  });
  await waitFor(() => expect(api().activeId).toBe('term-4'));
  expect(api().activeHostId).toBe('host-alpha');
  expect(api().getActiveSessionId()).toBe('term-4');
  expect(seen.closes).toBeGreaterThan(0);
});

test('newTerminal opens the next free id for the active host', async () => {
  const { api } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  await act(async () => {
    pollings[0]?.options.onSessions(profile, [
      { id: 'term-1', status: 'running', last_output_at: null },
      { id: 'term-2', status: 'running', last_output_at: null },
    ]);
  });
  await act(async () => {
    api().newTerminal();
  });
  await waitFor(() => expect(api().activeId).toBe('term-3'));
});

test('markAuthFailed surfaces on connectionStatus', async () => {
  const { api } = mount();
  await act(async () => {
    api().markAuthFailed();
  });
  expect(api().connectionStatus).toBe('auth-failed');
});

test('window focus round-trips', async () => {
  const { api } = mount();
  expect(api().isWindowFocused()).toBe(true);
  await act(async () => {
    api().setWindowFocused(false);
  });
  expect(api().isWindowFocused()).toBe(false);
});

test('terminal selection round-trips', async () => {
  const { api } = mount();
  expect(api().getTerminalSelection()).toBe('');
  await act(async () => {
    api().onRendererSelection('picked text');
  });
  expect(api().getTerminalSelection()).toBe('picked text');
});

test('removeHost drops that host from the drawer', async () => {
  const { api } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  await act(async () => {
    pollings[0]?.options.onSessions(profile, [
      { id: 'term-1', status: 'running', last_output_at: null },
    ]);
  });
  expect(api().drawerSessions).toHaveLength(1);
  await act(async () => {
    api().removeHost('host-alpha');
  });
  expect(api().drawerSessions).toEqual([]);
});

test('host polling survives an unrelated re-render', async () => {
  const { view, api, Probe } = mount();
  await waitFor(() => expect(pollings).toHaveLength(1));
  const polling = pollings[0];
  if (!polling) throw new Error('polling was never created');
  await act(async () => {
    api().setWindowFocused(false);
  });
  // Re-render the SAME tree with an unrelated prop change: the hook stays
  // mounted, so a torn-down or restarted poller would be visible here.
  await act(async () => {
    view.rerender(<Probe unrelated={1} />);
  });
  expect(pollings).toHaveLength(1);
  expect(polling.stop).not.toHaveBeenCalled();
  expect(polling.start).toHaveBeenCalledTimes(1);
});
