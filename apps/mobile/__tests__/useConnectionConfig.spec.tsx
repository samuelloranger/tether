import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { HostStore } from '../src/tether/hostStore';
import { useConnectionConfig } from '../src/tether/useConnectionConfig';

function Probe({ hostStore }: { hostStore: HostStore }) {
  const config = useConnectionConfig({ hostStore });
  return <Text>{config.storeError ?? 'loaded'}</Text>;
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
