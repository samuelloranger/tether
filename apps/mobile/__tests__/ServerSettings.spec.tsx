import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { ServerSettings } from '../src/ServerSettings';

const host = {
  id: 'host-1',
  name: 'Studio',
  color: '#89b4fa',
  host: 'studio.local',
  port: '8085',
  identityName: 'Studio',
  order: 0,
};
const config = {
  push: { enabled: true },
  pushDevices: 1,
  triggers: { waiting: true, oscNotify: true, exit: true, longJob: true },
  longJobSeconds: 300,
  identity: { name: 'Studio', color: '#89b4fa' },
  session: { defaultShell: 'zsh', defaultCwd: '/work', scrollbackRows: 2000, silenceMs: 15000 },
};

function client(
  post = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...config, ok: true }),
  })),
) {
  return {
    get: jest.fn(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () => (path === '/api/health' ? { ok: true, version: '1.2.3' } : config),
    })),
    post,
  };
}

test('renders all settings sections and saves one diffed PATCH', async () => {
  const mocked = client();
  const view = render(
    <AppThemeProvider>
      <ServerSettings
        visible
        host={host}
        client={mocked as never}
        health="reachable"
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onUnauthorized={jest.fn()}
        onIdentitySaved={jest.fn()}
        onPasswordChanged={async () => {}}
        onConnectionSaved={async () => {}}
        onRemoveHost={async () => {}}
      />
    </AppThemeProvider>,
  );
  await waitFor(() => expect(view.getByText('Name & colour')).toBeTruthy());
  expect(view.getByText('Connection')).toBeTruthy();
  expect(view.getByText('Notifications')).toBeTruthy();
  expect(view.getByText('Sessions')).toBeTruthy();
  expect(view.getByText('Maintenance')).toBeTruthy();
  expect(view.getByLabelText('Remove this host')).toBeTruthy();
  expect(view.getByText('Agent needs input')).toBeTruthy();
  expect(view.getByText('Alerts from programs')).toBeTruthy();
  expect(view.getByText('Session ends')).toBeTruthy();
  expect(view.getByText('Long command finishes')).toBeTruthy();
  expect(view.getByText('Count a command as long after')).toBeTruthy();
  expect(view.getByText('Mark a session idle after')).toBeTruthy();
  expect(view.getByLabelText('Send test notification')).toBeTruthy();
  fireEvent.changeText(view.getByDisplayValue('Studio'), 'Studio Mac');
  fireEvent.press(view.getByLabelText('Save changes'));
  await waitFor(() =>
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ identity: { name: 'Studio Mac' } }),
      }),
    ),
  );
}, 10_000);

test('renders an unreachable host as a read-only retry state', () => {
  const view = render(
    <AppThemeProvider>
      <ServerSettings
        visible
        host={host}
        client={client() as never}
        health="unreachable"
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onUnauthorized={jest.fn()}
        onIdentitySaved={jest.fn()}
        onPasswordChanged={async () => {}}
        onConnectionSaved={async () => {}}
        onRemoveHost={async () => {}}
      />
    </AppThemeProvider>,
  );
  expect(view.getByText('Host unreachable. Last-known settings are read-only.')).toBeTruthy();
  expect(view.getByText('Connection')).toBeTruthy();
  expect(view.getByLabelText('Address')).toHaveProp('value', 'studio.local');
  expect(view.getByLabelText('Remove this host')).toBeTruthy();
  expect(view.getByLabelText('Retry')).toBeTruthy();
});

test('keeps numeric fields empty while editing and shows validation errors inline', async () => {
  const view = render(
    <AppThemeProvider>
      <ServerSettings
        visible
        host={host}
        client={client() as never}
        health="reachable"
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onUnauthorized={jest.fn()}
        onIdentitySaved={jest.fn()}
        onPasswordChanged={async () => {}}
        onConnectionSaved={async () => {}}
        onRemoveHost={async () => {}}
      />
    </AppThemeProvider>,
  );

  await waitFor(() => expect(view.getByDisplayValue('2000')).toBeTruthy());
  fireEvent.changeText(view.getByDisplayValue('2000'), '');
  expect(view.getByLabelText('Scrollback rows')).toHaveProp('value', '');
  fireEvent.press(view.getByLabelText('Save changes'));

  expect(view.getByText('Scrollback must be between 100 and 100000 rows.')).toBeTruthy();
  expect(view.queryByTestId('server-settings-message-error')).toBeNull();
});

test('marks operation failures as error messages without inspecting the copy', async () => {
  const view = render(
    <AppThemeProvider>
      <ServerSettings
        visible
        host={host}
        client={client() as never}
        health="reachable"
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onUnauthorized={jest.fn()}
        onIdentitySaved={jest.fn()}
        onPasswordChanged={async () => {}}
        onConnectionSaved={async () => {}}
        onRemoveHost={async () => {}}
      />
    </AppThemeProvider>,
  );

  await waitFor(() => expect(view.getByText('Maintenance')).toBeTruthy());
  fireEvent.press(view.getByLabelText('Change password'));
  const inputs = view.getAllByDisplayValue('');
  fireEvent.changeText(inputs[0], 'current-password');
  fireEvent.changeText(inputs[1], 'new-password');
  fireEvent.changeText(inputs[2], 'different-password');
  fireEvent.press(view.getByLabelText('Confirm'));

  expect(view.getByTestId('server-settings-message-error')).toHaveTextContent(
    'New passwords must match.',
  );
});
