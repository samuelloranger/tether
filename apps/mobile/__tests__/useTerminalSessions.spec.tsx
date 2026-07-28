import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { HostClient } from '../src/tether/hostClient';
import type { HostProfile } from '../src/tether/hostStore';
import { useTerminalSessions } from '../src/tether/useTerminalSessions';

const pollings: Array<{
  options: { onHealth(profile: HostProfile, result: 'success' | 'failure' | 'unauthorized'): void };
  start: jest.Mock;
  stop: jest.Mock;
}> = [];

jest.mock('../src/terminalEngine', () => ({
  TerminalEngine: jest.fn(() => ({
    onReply: null,
    onClipboardWrite: null,
    serialize: () => '',
    cols: 80,
    rows: 24,
  })),
}));

jest.mock('../src/tether/hostPolling', () => ({
  createHostPolling: jest.fn((options) => {
    const polling = {
      options,
      start: jest.fn(async () => {}),
      stop: jest.fn(),
    };
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
const profiles = [profile];
const theme = { terminal: { fg: '#cdd6f4', bg: '#1e1e2e' } };

const client = {
  profile,
  get: jest.fn(),
  post: jest.fn(),
  url: jest.fn(),
  authHeader: {},
  openSocket: jest.fn(),
  loadIdentity: jest.fn(),
  baseUrl: 'http://alpha.local:8085',
} as unknown as HostClient;

const clientFor = () => client;
const notificationsEnabledRef = { current: false };

function Probe({
  onReachable,
  revision,
}: {
  onReachable: (host: HostProfile) => void;
  revision: number;
}) {
  useTerminalSessions({
    client,
    profiles,
    clientFor,
    onReachable,
    ready: false,
    isConfiguring: false,
    theme,
    fontFamily: 'monospace',
    fontSize: 14,
    notificationsEnabledRef,
    onClearView: () => {},
    onClearPresentation: () => {},
    onCloseDrawer: () => {},
  });
  return <Text>{revision}</Text>;
}

test('keeps host polling alive across an unrelated re-render while using the latest reachable callback', async () => {
  pollings.length = 0;
  const first = jest.fn();
  const current = jest.fn();
  const view = render(<Probe onReachable={first} revision={1} />);

  await waitFor(() => expect(pollings).toHaveLength(1));
  const polling = pollings[0];
  if (!polling) throw new Error('host polling was not created');

  view.rerender(<Probe onReachable={current} revision={2} />);

  expect(pollings).toHaveLength(1);
  expect(polling.stop).not.toHaveBeenCalled();

  await act(async () => {
    polling.options.onHealth(profile, 'success');
  });

  expect(first).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith(profile);
});
