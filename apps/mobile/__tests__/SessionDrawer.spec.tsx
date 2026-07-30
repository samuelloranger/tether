import { fireEvent, render } from '@testing-library/react-native';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { SessionDrawer } from '../src/SessionDrawer';
import type { HostProfile } from '../src/tether/hostStore';

const hosts: HostProfile[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    color: '#89b4fa',
    host: 'alpha.local',
    port: '8085',
    identityName: 'alpha',
    order: 0,
  },
  {
    id: 'beta',
    name: 'Beta',
    color: '#f38ba8',
    host: 'beta.local',
    port: '8085',
    identityName: 'beta',
    order: 1,
  },
];

function renderDrawer(overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {}) {
  const props = {
    visible: true,
    hosts,
    healthByHost: { alpha: 'reachable', beta: 'unreachable' } as const,
    sessions: [{ hostId: 'alpha', id: 'term-1', status: 'running' as const, last_output_at: null }],
    activeHostId: 'alpha',
    activeId: 'term-1',
    onSelect: jest.fn(),
    onNew: jest.fn(),
    onKill: jest.fn(),
    onRetryHost: jest.fn(),
    onReenterPassword: jest.fn(),
    previews: [],
    activePreviewId: null,
    onSelectPreview: jest.fn(),
    onClosePreview: jest.fn(),
    onClose: jest.fn(),
    onHostSettings: jest.fn(),
    ...overrides,
  };
  return {
    props,
    view: render(
      <AppThemeProvider>
        <SessionDrawer {...props} />
      </AppThemeProvider>,
    ),
  };
}

test('renders one host section and collapses an unreachable host', () => {
  const { view } = renderDrawer();
  expect(view.getByText('Alpha')).toBeTruthy();
  expect(view.getByText('Beta')).toBeTruthy();
  expect(view.getByLabelText('Retry Beta')).toBeTruthy();
  expect(view.queryByLabelText('Terminal term-1 on Beta')).toBeNull();
  expect(view.queryByLabelText('Add host')).toBeNull();
});

test('reports a selected terminal with its host id', () => {
  const { props, view } = renderDrawer();
  fireEvent.press(view.getByLabelText(/Terminal term-1 on Alpha/));
  expect(props.onSelect).toHaveBeenCalledWith('alpha', 'term-1');
});

test.each([
  ['overlay', false],
  ['docked', true],
] as const)('shows the same host navigation without a workspace header when %s', (_, docked) => {
  const { view } = renderDrawer({ docked });

  expect(view.getByLabelText('Alpha host section')).toBeTruthy();
  expect(view.getByLabelText(/Terminal term-1 on Alpha/)).toBeTruthy();
  expect(view.getByLabelText('Server settings for Alpha')).toBeTruthy();
  expect(view.queryByLabelText('Add host')).toBeNull();
  expect(view.getByLabelText('New terminal')).toBeTruthy();
  expect(view.queryByText('Workspace')).toBeNull();
  expect(view.queryByLabelText('Settings')).toBeNull();
});
