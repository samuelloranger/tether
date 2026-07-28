import { fireEvent, render } from '@testing-library/react-native';
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
        storeError="Hosts could not be loaded. Check device storage and retry."
        onRetryHosts={retry}
      />
    </AppThemeProvider>,
  );

  expect(view.getByText('Hosts unavailable')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Retry loading hosts'));
  expect(retry).toHaveBeenCalledTimes(1);
});
