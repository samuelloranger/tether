import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { buildFileTree, type DiffFileStat } from '../src/diffModel';
import { FileTree } from '../src/FileTree';
import { toggleSetMember } from '../src/gitReviewModel';

const staged: DiffFileStat[] = [
  { path: 'src/a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
];
const unstaged: DiffFileStat[] = [
  { path: 'src/b.ts', insertions: 0, deletions: 1, binary: false, staged: false },
];

function DualTree() {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsedDirs((prev) => toggleSetMember(prev, key));
  return (
    <View>
      <FileTree
        nodes={buildFileTree(staged)}
        collapseScope="staged"
        collapsedDirs={collapsedDirs}
        onToggleDir={toggle}
        onSelectFile={() => {}}
      />
      <FileTree
        nodes={buildFileTree(unstaged)}
        collapseScope="unstaged"
        collapsedDirs={collapsedDirs}
        onToggleDir={toggle}
        onSelectFile={() => {}}
      />
    </View>
  );
}

test('collapsing a folder in Staged does not collapse the same folder in Changes', () => {
  const view = render(
    <AppThemeProvider>
      <DualTree />
    </AppThemeProvider>,
  );

  expect(view.getByText('a.ts')).toBeTruthy();
  expect(view.getByText('b.ts')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Collapse staged folder src'));
  expect(view.queryByText('a.ts')).toBeNull();
  expect(view.getByText('b.ts')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Collapse unstaged folder src'));
  expect(view.queryByText('a.ts')).toBeNull();
  expect(view.queryByText('b.ts')).toBeNull();
});
