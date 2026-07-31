import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { UtilityBar } from '../src/UtilityBar';

// Every control here must reach the PTY through sendKey, which is where the
// armed Ctrl modifier is applied. A control wired straight to sendInput looks
// identical on screen and in a unit test of the sender — it only shows up as a
// key that silently ignores Ctrl, which is exactly how v2.2.1 shipped broken.
function renderBar(overrides: Partial<Parameters<typeof UtilityBar>[0]> = {}) {
  const props = {
    ctrlArmed: false,
    setCtrlArmed: jest.fn(),
    sendKey: jest.fn(),
    cursorSeq: (final: string) => `\x1b[${final}`,
    page: 0,
    setPage: jest.fn(),
    onPaste: jest.fn(),
    onImagePick: jest.fn(),
    onHideKeyboard: jest.fn(),
    ...overrides,
  };
  const view = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }}
    >
      <AppThemeProvider>
        <UtilityBar {...props} />
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
  return { ...props, view };
}

test('page 1 keys send their sequences through sendKey', () => {
  const bar = renderBar();
  fireEvent.press(bar.view.getByLabelText('Tab'));
  expect(bar.sendKey).toHaveBeenCalledWith('\t');
  fireEvent.press(bar.view.getByLabelText('Esc'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b');
});

test('the Ctrl key toggles the armed modifier rather than sending bytes', () => {
  const bar = renderBar();
  fireEvent.press(bar.view.getByLabelText('Control modifier'));
  expect(bar.setCtrlArmed).toHaveBeenCalledTimes(1);
  expect(bar.sendKey).not.toHaveBeenCalled();
  // The updater must toggle, not force a value, or a double tap sticks.
  const updater = (bar.setCtrlArmed as jest.Mock).mock.calls[0][0] as (prev: boolean) => boolean;
  expect(updater(false)).toBe(true);
  expect(updater(true)).toBe(false);
});

test('cursor keys are built with cursorSeq so application-cursor mode is honoured', () => {
  const bar = renderBar({ page: 1 });
  fireEvent.press(bar.view.getByLabelText('Home'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b[H');
  fireEvent.press(bar.view.getByLabelText('End'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b[F');
});

test('page 2 keys send their sequences through sendKey', () => {
  const bar = renderBar({ page: 1 });
  fireEvent.press(bar.view.getByLabelText('Del'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b[3~');
  fireEvent.press(bar.view.getByLabelText('PgUp'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b[5~');
  fireEvent.press(bar.view.getByLabelText('PgDn'));
  expect(bar.sendKey).toHaveBeenCalledWith('\x1b[6~');
});

test('the pager is the edge control of the page it moves away from', () => {
  const first = renderBar({ page: 0 });
  expect(first.view.queryByLabelText('Previous utility page')).toBeNull();
  fireEvent.press(first.view.getByLabelText('Next utility page'));
  expect(first.setPage).toHaveBeenCalledWith(1);

  first.view.unmount();
  const second = renderBar({ page: 1 });
  expect(second.view.queryByLabelText('Next utility page')).toBeNull();
  fireEvent.press(second.view.getByLabelText('Previous utility page'));
  expect(second.setPage).toHaveBeenCalledWith(0);
});

test('only the current page is mounted, so there is nothing to scroll sideways', () => {
  const bar = renderBar({ page: 0 });
  expect(bar.view.getByLabelText('Tab')).toBeTruthy();
  expect(bar.view.queryByLabelText('PgUp')).toBeNull();
});
