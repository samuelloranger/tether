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

test('embedded mode still renders hunk actions without nesting a scroll view', () => {
  const { view } = renderBody({
    scrollable: false,
    diffText: '@@ -1,1 +1,2 @@ fn\n context\n+added\n',
    onHunkPress: jest.fn(),
    hunkActionLabel: 'Stage',
  });
  expect(view.getByLabelText('Stage hunk 1')).toBeTruthy();
});
