import { render } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { TerminalScreen } from '../src/TerminalScreen';
import { DomainFixture } from './mocks/tetherDomains';

jest.mock('../src/platform', () => ({
  isDesktop: true,
  isMacDesktop: false,
  isTauri: () => false,
}));

jest.mock('../src/TerminalView', () => {
  const { View: MockView } = require('react-native');
  return {
    TerminalView: () => <MockView testID="terminal-renderer" />,
    __esModule: true,
  };
});

jest.mock('../src/TitleBar', () => ({ __esModule: true, default: () => null }));
jest.mock('../src/UtilityBar', () => ({ UtilityBar: () => null }));
jest.mock('../src/ContextMenu', () => ({ ContextMenu: () => null }));
jest.mock('../src/UpdateModal', () => ({ UpdateModal: () => null }));
jest.mock('../src/AlertModal', () => ({ AlertModal: () => null }));
jest.mock('../src/terminalScrollbar', () => ({ injectTerminalScrollbarStyles: jest.fn() }));

const host = {
  id: 'studio',
  name: 'Studio',
  color: '#89b4fa',
  host: 'studio.local',
  port: '8085',
  identityName: 'studio',
  order: 0,
};

const summary = {
  files: [
    { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
    { path: 'b.ts', insertions: 0, deletions: 1, binary: false, staged: false },
  ],
};

function appFixture(overrides: Record<string, unknown> = {}) {
  const noop = jest.fn();
  const known = {
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    client: {},
    serverIp: host.host,
    port: host.port,
    connectionStatus: 'connected',
    hasConnected: true,
    ctxMenu: null,
    updateInfo: null,
    updating: false,
    ctrlArmed: false,
    utilityPage: 0,
    selectionViewOpen: false,
    menuOpen: false,
    renameModalOpen: false,
    renameText: '',
    appearanceModalOpen: false,
    searchQuery: '',
    searchInputRef: { current: null },
    snippets: [],
    snippetsModalOpen: false,
    snippetDraft: '',
    activeId: 'term-1',
    activeHostId: host.id,
    drawerOpen: false,
    setDrawerOpen: noop,
    drawerSessions: [
      {
        hostId: host.id,
        id: 'term-1',
        status: 'running' as const,
        last_output_at: null,
      },
    ],
    profiles: [host],
    healthByHost: { [host.id]: 'reachable' as const },
    deepLinkNotice: null,
    presentations: [],
    activePresentation: null,
    activePresentationId: null,
    fileView: null,
    fileLoading: false,
    diffOpen: true,
    changeSummary: summary,
    diffSelectedPath: null,
    diffText: null,
    diffTruncated: false,
    diffLoading: false,
    diffImage: null,
    diffMode: null,
    historyEntries: null,
    historyCommit: null,
    diffSideBySide: false,
    reviewDiffs: {},
    inputRef: { current: null },
    fontSize: 14,
    lineHeight: 20,
    entryFor: () => ({ term: { title: 'Terminal', cwd: '/workspace' } }),
    terminalViewRef: { current: null },
    fontFamily: 'FiraCode',
    mouseEnabled: false,
    notificationsEnabled: false,
    activeName: 'Terminal',
    activeBellCount: 0,
    upPct: 0,
    upLabel: '',
    titleBarStatus: 'connected',
    ...overrides,
  };

  return new Proxy(known, {
    get(target, property) {
      return property in target ? target[property as keyof typeof target] : noop;
    },
  }) as unknown;
}

function setWindowWidth(width: number) {
  Dimensions.set({
    window: { width, height: 800, scale: 1, fontScale: 1 },
    screen: { width, height: 800, scale: 1, fontScale: 1 },
  });
}

function renderScreen(width: number, overrides: Record<string, unknown> = {}) {
  setWindowWidth(width);
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width, height: 800 },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }}
    >
      <AppThemeProvider>
        <DomainFixture value={appFixture(overrides)}>
          <TerminalScreen />
        </DomainFixture>
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
});

test('desktop keeps the terminal mounted under GitDrawer', () => {
  const view = renderScreen(1200);
  expect(view.getByTestId('terminal-renderer')).toBeTruthy();
  expect(view.getByLabelText('Close git drawer')).toBeTruthy();
  expect(view.queryByLabelText('Back to terminal')).toBeNull();
  expect(view.queryByLabelText(/View changes/)).toBeNull();
});

test('compact shell uses full-screen GitReview without GitDrawer', () => {
  const view = renderScreen(500);
  expect(view.getByLabelText('Back to terminal')).toBeTruthy();
  expect(view.queryByLabelText('Close git drawer')).toBeNull();
  expect(view.queryByTestId('terminal-renderer')).toBeNull();
});
