import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { HostsScreen } from '../src/HostsScreen';

const hosts = [
  {
    id: 'studio',
    name: 'Studio',
    color: '#89b4fa',
    host: 'studio.local',
    port: '8085',
    identityName: 'Studio',
    order: 0,
  },
  {
    id: 'laptop',
    name: 'Laptop',
    color: '#a6e3a1',
    host: 'laptop.local',
    port: '8085',
    identityName: 'Laptop',
    order: 1,
  },
];

test('reorders from the row drag handle without exposing inline editor controls', () => {
  const reorder = jest.fn();
  const view = render(
    <AppThemeProvider>
      <HostsScreen
        hosts={hosts}
        onBack={jest.fn()}
        onAdd={jest.fn()}
        onAppearance={jest.fn()}
        onOpen={jest.fn()}
        onReorder={reorder}
      />
    </AppThemeProvider>,
  );

  expect(view.queryByLabelText('Move Studio down')).toBeNull();
  expect(view.queryByLabelText('Color')).toBeNull();
  fireEvent(view.getByLabelText('Reorder Studio'), 'accessibilityAction', {
    nativeEvent: { actionName: 'increment' },
  });
  expect(reorder).toHaveBeenCalledWith(['laptop', 'studio']);
});
