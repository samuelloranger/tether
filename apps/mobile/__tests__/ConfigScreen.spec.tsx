import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { ConfigScreen } from '../src/ConfigScreen';

test('renders a retryable state when loading hosts fails instead of mounting the pairing form', () => {
  const retry = jest.fn();
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
        storeError="Hosts could not be loaded. Check device storage and retry."
        onRetryHosts={retry}
      />
    </AppThemeProvider>,
  );

  expect(view.getByText('Hosts unavailable')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Retry loading hosts'));
  expect(retry).toHaveBeenCalledTimes(1);
});

test('exposes programmatic labels for every connection field', () => {
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
      />
    </AppThemeProvider>,
  );

  expect(view.getByLabelText('Server IP or host')).toBeTruthy();
  expect(view.getByLabelText('Port')).toBeTruthy();
  expect(view.getByLabelText('Password')).toBeTruthy();
});

test('backs out of the Hosts landing page instead of opening the pairing form', () => {
  const closeSettings = jest.fn();
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        hosts={[
          {
            id: 'prod',
            name: 'Production',
            host: 'tether.example.test',
            port: '8085',
            color: '#4ade80',
            identityName: 'production',
            order: 0,
          },
        ]}
        onAddHost={jest.fn()}
        onReorderHosts={jest.fn()}
        onCloseSettings={closeSettings}
      />
    </AppThemeProvider>,
  );

  expect(view.queryByLabelText('Server IP or host')).toBeNull();
  fireEvent.press(view.getByLabelText('Close settings'));
  expect(closeSettings).toHaveBeenCalledTimes(1);
  expect(view.queryByLabelText('Server IP or host')).toBeNull();
});

test('opens Appearance from the Settings landing page', () => {
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
        hosts={[]}
        onAddHost={jest.fn()}
        onReorderHosts={jest.fn()}
        renderAppearancePage={() => <Text>Appearance page</Text>}
      />
    </AppThemeProvider>,
  );

  fireEvent.press(view.getByLabelText('Open appearance settings'));
  expect(view.getByText('Appearance page')).toBeTruthy();
});

test('opens the add-host pairing flow from Settings', () => {
  const addHost = jest.fn();
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
        hosts={[]}
        onAddHost={addHost}
        onReorderHosts={jest.fn()}
      />
    </AppThemeProvider>,
  );

  fireEvent.press(view.getByLabelText('Add host'));
  expect(addHost).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('Server IP or host')).toBeTruthy();
});

test('opens the same host page directly from a host row', () => {
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
        hosts={[
          {
            id: 'prod',
            name: 'Production',
            host: 'tether.example.test',
            port: '8085',
            color: '#4ade80',
            identityName: 'production',
            order: 0,
          },
        ]}
        onAddHost={jest.fn()}
        onReorderHosts={jest.fn()}
        renderHostPage={() => <Text>Unified host page</Text>}
      />
    </AppThemeProvider>,
  );

  fireEvent.press(view.getByLabelText('Production, Checking…. Open host settings'));
  expect(view.getByText('Unified host page')).toBeTruthy();
});

test('opens the unified host page when Settings is entered from a drawer host gear', () => {
  const view = render(
    <AppThemeProvider>
      <ConfigScreen
        serverIp=""
        setServerIp={jest.fn()}
        port="8085"
        setPort={jest.fn()}
        password=""
        setPassword={jest.fn()}
        confirmPassword=""
        setConfirmPassword={jest.fn()}
        setupMode="unknown"
        setSetupMode={jest.fn()}
        testStatus={{ kind: 'idle' }}
        setTestStatus={jest.fn()}
        onSave={jest.fn()}
        onTest={jest.fn()}
        onCloseSettings={jest.fn()}
        hosts={[
          {
            id: 'prod',
            name: 'Production',
            host: 'tether.example.test',
            port: '8085',
            color: '#4ade80',
            identityName: 'production',
            order: 0,
          },
        ]}
        onAddHost={jest.fn()}
        onReorderHosts={jest.fn()}
        initialHostId="prod"
        renderHostPage={() => <Text>Unified host page</Text>}
      />
    </AppThemeProvider>,
  );

  expect(view.getByText('Unified host page')).toBeTruthy();
});
