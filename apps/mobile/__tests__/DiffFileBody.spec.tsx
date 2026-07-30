import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { DiffFileBody } from '../src/DiffFileBody';

function renderBody(overrides: Partial<Parameters<typeof DiffFileBody>[0]> = {}) {
  const props = {
    loading: false,
    path: 'a.ts',
    diffText: '',
    truncated: false,
    sideBySide: false,
    wideEnough: false,
    ...overrides,
  };
  return {
    props,
    view: render(
      <AppThemeProvider>
        <DiffFileBody {...props} />
      </AppThemeProvider>,
    ),
  };
}

test('shows a loading indicator while the diff loads', () => {
  const { view } = renderBody({ loading: true });
  expect(view.getByTestId('diff-file-loading')).toBeTruthy();
});

test('shows an error and retries', () => {
  const onRetry = jest.fn();
  const { view } = renderBody({ error: 'boom', onRetry });
  expect(view.getByText('boom')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Retry loading diff'));
  expect(onRetry).toHaveBeenCalled();
});
