import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { OverflowMenu } from '../src/OverflowMenu';

jest.mock('../src/platform', () => ({
  isDesktop: true,
  isMacDesktop: false,
  isTauri: () => false,
}));

test('does not offer obsolete desktop navigation modes', () => {
  const noop = jest.fn();
  const view = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 1024, height: 800 },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }}
    >
      <AppThemeProvider>
        <OverflowMenu
          visible
          onClose={noop}
          onRename={noop}
          onViewChanges={noop}
          fontSize={14}
          onFontDelta={noop}
          mouseEnabled={false}
          onToggleMouse={noop}
          onSelectText={noop}
          onJumpPromptUp={noop}
          onJumpPromptDown={noop}
          onSnippets={noop}
          onAppearance={noop}
          notificationsEnabled={false}
          onToggleNotifications={noop}
          onTestNotification={noop}
          onCheckUpdates={noop}
          onRestart={noop}
        />
      </AppThemeProvider>
    </SafeAreaProvider>,
  );

  expect(view.queryByText('Navigation')).toBeNull();
  expect(view.queryByLabelText('Navigation: Sidebar')).toBeNull();
  expect(view.queryByLabelText('Navigation: On hover')).toBeNull();
  expect(view.queryByLabelText('Navigation: Tabs')).toBeNull();
});
