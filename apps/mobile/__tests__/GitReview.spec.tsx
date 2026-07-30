import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import type { DiffSummary } from '../src/diffModel';
import type { ReviewDiffSlot } from '../src/fetchReviewDiff';
import { GitReview } from '../src/GitReview';

const summary: DiffSummary = {
  files: [
    { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
    { path: 'b.ts', insertions: 0, deletions: 1, binary: false, staged: false },
  ],
};

const reviewDiffs: Record<string, ReviewDiffSlot> = {
  'staged:a.ts': {
    status: 'ready',
    text: '@@ -1,1 +1,2 @@\n context\n+added\n',
    truncated: false,
  },
  'unstaged:b.ts': {
    status: 'ready',
    text: '@@ -1,2 +1,1 @@\n context\n-removed\n',
    truncated: false,
  },
};

function renderReview(overrides: Partial<Parameters<typeof GitReview>[0]> = {}) {
  const props: Parameters<typeof GitReview>[0] = {
    summary,
    onBack: jest.fn(),
    onStageFile: jest.fn(),
    onUnstageFile: jest.fn(),
    onDiscardFile: jest.fn(),
    onToggleHunk: jest.fn(),
    onCommit: jest.fn(async () => true),
    onAmend: jest.fn(async () => true),
    onUndoCommit: jest.fn(),
    onPush: jest.fn(),
    onStageAll: jest.fn(),
    onUnstageAll: jest.fn(),
    onDiscardAll: jest.fn(),
    onOpenLine: jest.fn(),
    repoStatus: {
      branch: 'main',
      shortSha: 'abc1234',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
    },
    historyEntries: null,
    historyCommit: null,
    onLoadHistory: jest.fn(),
    onSelectCommit: jest.fn(),
    reviewDiffs,
    onRetryReviewDiff: jest.fn(),
    ...overrides,
  };
  return {
    props,
    view: render(
      <AppThemeProvider>
        <GitReview {...props} />
      </AppThemeProvider>,
    ),
  };
}

test('renders continuous staged then changes with top commit box', () => {
  const { view } = renderReview();
  expect(view.getByLabelText('Back to terminal')).toBeTruthy();
  expect(view.getByPlaceholderText('Commit message')).toBeTruthy();
  expect(view.getByText('Staged (1)')).toBeTruthy();
  expect(view.getByText('Changes (1)')).toBeTruthy();
  expect(view.getByLabelText('Stage hunk 1')).toBeTruthy();
});

test('collapses and expands a file from its header', () => {
  const { view } = renderReview();
  expect(view.getByLabelText('Unstage hunk 1')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Collapse file a.ts'));
  expect(view.queryByLabelText('Unstage hunk 1')).toBeNull();
  fireEvent.press(view.getByLabelText('Expand file a.ts'));
  expect(view.getByLabelText('Unstage hunk 1')).toBeTruthy();
});
