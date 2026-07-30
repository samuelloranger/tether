import { fireEvent, render } from '@testing-library/react-native';
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
  expect(view.getByPlaceholderText('Commit message')).toBeTruthy();
  expect(view.getByLabelText('Commit staged changes')).toBeDisabled();
  fireEvent.changeText(view.getByPlaceholderText('Commit message'), 'fix bugs');
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

test('chevron menu exposes Amend, Undo, and Push', () => {
  const onAmend = jest.fn();
  const onUndoCommit = jest.fn();
  const onPush = jest.fn();
  const { view } = renderBox({
    message: 'fix bugs',
    onAmend,
    onUndoCommit,
    onPush,
    canAmend: true,
    canPush: true,
  });
  expect(view.queryByLabelText('Amend last commit')).toBeNull();
  fireEvent.press(view.getByLabelText('More git actions'));
  fireEvent.press(view.getByLabelText('Amend last commit'));
  expect(onAmend).toHaveBeenCalled();

  const { view: again } = renderBox({
    message: 'fix bugs',
    onAmend,
    onUndoCommit,
    onPush,
    canAmend: true,
    canPush: true,
  });
  fireEvent.press(again.getByLabelText('More git actions'));
  fireEvent.press(again.getByLabelText('Push to remote'));
  expect(onPush).toHaveBeenCalled();
});

test('hides chevron when no menu actions are provided', () => {
  const { view } = renderBox({ message: 'fix bugs' });
  expect(view.queryByLabelText('More git actions')).toBeNull();
});
