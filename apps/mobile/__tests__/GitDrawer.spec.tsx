import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { GitDrawer } from '../src/GitDrawer';
import type { DiffSummary } from '../src/diffModel';

const summary: DiffSummary = {
  files: [
    { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
    { path: 'b.ts', insertions: 0, deletions: 1, binary: false, staged: false },
  ],
};

function renderDrawer(overrides: Partial<Parameters<typeof GitDrawer>[0]> = {}) {
  const props = {
    summary,
    selectedPath: null,
    diffMode: null as 'staged' | 'unstaged' | null,
    diffText: null,
    diffTruncated: false,
    diffLoading: false,
    diffImage: null,
    onSelectFile: jest.fn(),
    onDeselectFile: jest.fn(),
    onBack: jest.fn(),
    onStageFile: jest.fn(),
    onUnstageFile: jest.fn(),
    onDiscardFile: jest.fn(),
    onToggleHunk: jest.fn(),
    onCommit: jest.fn(async () => true),
    historyEntries: null,
    historyCommit: null,
    onLoadHistory: jest.fn(),
    onSelectCommit: jest.fn(),
    sideBySide: false,
    onToggleSideBySide: jest.fn(),
    ...overrides,
  };
  return {
    props,
    view: render(
      <AppThemeProvider>
        <GitDrawer {...props} />
      </AppThemeProvider>,
    ),
  };
}

test('renders staged and changes columns with empty right pane', () => {
  const { view } = renderDrawer();
  expect(view.getByLabelText('Close git drawer')).toBeTruthy();
  expect(view.getByText('Staged (1)')).toBeTruthy();
  expect(view.getByText('Changes (1)')).toBeTruthy();
  expect(view.getByPlaceholderText('Commit message')).toBeTruthy();
  expect(view.getByText('Select a file')).toBeTruthy();
});

test('selecting a file reports path and mode', () => {
  const { props, view } = renderDrawer();
  fireEvent.press(view.getByText('b.ts'));
  expect(props.onSelectFile).toHaveBeenCalledWith('b.ts', 'unstaged');
  fireEvent.press(view.getByText('a.ts'));
  expect(props.onSelectFile).toHaveBeenCalledWith('a.ts', 'staged');
});
