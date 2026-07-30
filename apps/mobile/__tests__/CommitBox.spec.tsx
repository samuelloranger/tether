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
