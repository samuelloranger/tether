import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import TitleBar from '../src/TitleBar';

jest.mock('../src/windowControls', () => ({
  closeWindow: jest.fn(),
  minimizeWindow: jest.fn(),
  toggleMaximizeWindow: jest.fn(),
  onMaximizeChange: async () => () => {},
  onFullscreenChange: async () => () => {},
}));

jest.mock('../src/dragRegion', () => ({
  DRAG_PROPS: {},
  NO_DRAG_PROPS: {},
}));

test('shows a changes button beside Settings when the summary is nonempty', () => {
  const onChanges = jest.fn();
  const view = render(
    <AppThemeProvider>
      <TitleBar
        isMac={false}
        title="term-1"
        onChanges={onChanges}
        changeSummary={{
          files: [{ path: 'a.ts', insertions: 2, deletions: 1, binary: false }],
        }}
        onSettings={jest.fn()}
      />
    </AppThemeProvider>,
  );
  expect(view.getByLabelText('View changes, +2 -1')).toBeTruthy();
  expect(view.getByLabelText('Settings')).toBeTruthy();
  fireEvent.press(view.getByLabelText('View changes, +2 -1'));
  expect(onChanges).toHaveBeenCalled();
});

test('hides the changes button when there are no changes', () => {
  const view = render(
    <AppThemeProvider>
      <TitleBar
        isMac={false}
        title="term-1"
        onChanges={jest.fn()}
        changeSummary={{ files: [] }}
        onSettings={jest.fn()}
      />
    </AppThemeProvider>,
  );
  expect(view.queryByLabelText(/View changes/)).toBeNull();
  expect(view.getByLabelText('Settings')).toBeTruthy();
});
