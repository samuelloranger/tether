import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import type { HostProfile, HostStore } from '../src/tether/hostStore';
import { useConnectionConfig } from '../src/tether/useConnectionConfig';

function Probe({ hostStore }: { hostStore: HostStore }) {
  const config = useConnectionConfig({ hostStore });
  return <Text>{config.storeError ?? 'loaded'}</Text>;
}

function CreationProbe({ hostStore }: { hostStore: HostStore }) {
  const config = useConnectionConfig({ hostStore });
  return (
    <>
      <Text testID="active-host">{config.activeHostId ?? 'none'}</Text>
      <Text testID="ready">{String(config.ready)}</Text>
      <Text testID="server-ip">{config.serverIp}</Text>
      <Pressable
        accessibilityLabel="Set host details"
        onPress={() => {
          config.setServerIp('studio.local');
          config.setPort('8085');
          config.setPassword('secret');
        }}
      />
      <Pressable accessibilityLabel="Save host" onPress={() => void config.saveConfig()} />
    </>
  );
}

test('turns a rejecting host-store list into a visible retryable state', async () => {
  const hostStore: HostStore = {
    list: async () => Promise.reject(new Error('SecureStore unavailable')),
    create: async () => {
      throw new Error('unused');
    },
    update: async () => {
      throw new Error('unused');
    },
    remove: async () => {
      throw new Error('unused');
    },
    reorder: async () => Promise.reject(new Error('unused')),
  };
  const view = render(<Probe hostStore={hostStore} />);

  await waitFor(() => {
    expect(
      view.getByText('Hosts could not be loaded. Check device storage and retry.'),
    ).toBeTruthy();
  });
});

test('activates a newly created host immediately', async () => {
  const created: HostProfile = {
    id: 'host-1',
    name: 'Studio',
    color: '#89b4fa',
    host: 'studio.local',
    port: '8085',
    identityName: '',
    order: 0,
  };
  const hostStore: HostStore = {
    list: async () => [],
    create: async () => created,
    update: async () => {
      throw new Error('unused');
    },
    remove: async () => {
      throw new Error('unused');
    },
    reorder: async () => {
      throw new Error('unused');
    },
  };
  const view = render(<CreationProbe hostStore={hostStore} />);

  fireEvent.press(view.getByLabelText('Set host details'));
  await waitFor(() => expect(view.getByTestId('server-ip')).toHaveTextContent('studio.local'));
  fireEvent.press(view.getByLabelText('Save host'));

  await waitFor(() => expect(view.getByTestId('active-host')).toHaveTextContent('host-1'));
  expect(view.getByTestId('ready')).toHaveTextContent('true');
});
