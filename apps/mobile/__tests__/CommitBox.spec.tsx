import { fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { CommitBox } from '../src/CommitBox';

function renderBox(overrides: Partial<Parameters<typeof CommitBox>[0]> = {}) {
  const props = {
    message: '',
    onChangeMessage: jest.fn(),
    onCommit: jest.fn(),
    stagedCount: 1,
    committing: false,
    ...overrides,
  };
  return {
    props,
    view: render(
      <AppThemeProvider>
        <CommitBox {...props} />
      </AppThemeProvider>,
    ),
  };
}

test('enables Commit after a message and calls onCommit', () => {
  const { props, view } = renderBox();
  expect(view.getByLabelText('Commit message')).toBeTruthy();
  expect(view.getByLabelText('Commit staged changes')).toBeDisabled();
  fireEvent.changeText(view.getByLabelText('Commit message'), 'fix bugs');
  expect(props.onChangeMessage).toHaveBeenCalledWith('fix bugs');

  const { view: withMessage } = renderBox({ message: 'fix bugs' });
  expect(withMessage.getByLabelText('Commit staged changes')).not.toBeDisabled();
  fireEvent.press(withMessage.getByLabelText('Commit staged changes'));
  expect(withMessage).toBeTruthy();
});

test('calls onCommit when pressed with a valid message', () => {
  const onCommit = jest.fn();
  const { view } = renderBox({ message: 'fix bugs', onCommit });
  fireEvent.press(view.getByLabelText('Commit staged changes'));
  expect(onCommit).toHaveBeenCalled();
});

test('stays disabled with a message when nothing is staged', () => {
  const { view } = renderBox({ message: 'fix bugs', stagedCount: 0 });
  expect(view.getByLabelText('Commit staged changes')).toBeDisabled();
});

test('native more-menu uses a system alert with enabled actions', () => {
  const onAmend = jest.fn();
  const onUndoCommit = jest.fn();
  const onPush = jest.fn();
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    const amend = buttons?.find((b) => 'text' in b && b.text === 'Amend');
    if (amend && 'onPress' in amend) amend.onPress?.();
  });
  const { view } = renderBox({
    message: 'fix bugs',
    onAmend,
    onUndoCommit,
    onPush,
    canAmend: true,
    canPush: true,
  });
  fireEvent.press(view.getByLabelText('More git actions'));
  expect(alertSpy).toHaveBeenCalled();
  expect(onAmend).toHaveBeenCalled();
  alertSpy.mockRestore();
});

test('native more-menu omits rewrite actions when not allowed', () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { view } = renderBox({
    message: 'fix bugs',
    onAmend: jest.fn(),
    onUndoCommit: jest.fn(),
    onPush: jest.fn(),
    canAmend: false,
    canPush: false,
  });
  fireEvent.press(view.getByLabelText('More git actions'));
  const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text: string }> | undefined;
  expect(buttons?.map((b) => b.text)).toEqual(['Cancel']);
  alertSpy.mockRestore();
});

test('hides chevron when no menu actions are provided', () => {
  const { view } = renderBox({ message: 'fix bugs' });
  expect(view.queryByLabelText('More git actions')).toBeNull();
});
