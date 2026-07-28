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
  notify: { enabled: true, url: 'https://ntfy.sh', topic: 'tether', hasToken: true },
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
      />
    </AppThemeProvider>,
  );
  await waitFor(() => expect(view.getByText('Identity')).toBeTruthy());
  expect(view.getByText('Notifications')).toBeTruthy();
  expect(view.getByText('Session defaults')).toBeTruthy();
  expect(view.getByText('Server ops')).toBeTruthy();
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
});

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
      />
    </AppThemeProvider>,
  );
  expect(view.getByText('Host unreachable. Last-known settings are read-only.')).toBeTruthy();
  expect(view.getByLabelText('Retry')).toBeTruthy();
});
