import { render } from '@testing-library/react-native';

jest.mock('../src/platform', () => ({ isDesktop: true, isMacDesktop: false }));
jest.mock('../src/windowControls', () => ({
  closeWindow: jest.fn(),
  minimizeWindow: jest.fn(),
  onFullscreenChange: jest.fn(async () => () => {}),
  onMaximizeChange: jest.fn(async () => () => {}),
  toggleMaximizeWindow: jest.fn(),
}));

import { AppThemeProvider } from '../src/AppThemeProvider';
import { ConfigScreen } from '../src/ConfigScreen';

test('keeps the desktop title bar on the Settings route', () => {
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
      />
    </AppThemeProvider>,
  );

  expect(view.getAllByText('Settings')).toHaveLength(2);
});
