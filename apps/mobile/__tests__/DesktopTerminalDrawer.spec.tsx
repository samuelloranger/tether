import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Dimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { TerminalScreen } from '../src/TerminalScreen';
import type { useTetherApp } from '../src/useTetherApp';

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

jest.mock('../src/TitleBar', () => {
  const { TouchableOpacity, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onOpenDrawer }: { onOpenDrawer?: () => void }) =>
      onOpenDrawer ? (
        <TouchableOpacity accessibilityLabel="Open terminal list" onPress={onOpenDrawer}>
          <Text>menu</Text>
        </TouchableOpacity>
      ) : null,
  };
});
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

function appFixture(
  drawerOpen: boolean,
  setDrawerOpen: (open: boolean) => void,
  sidebarPinned = false,
  persistSidebarPinned: (next: boolean) => void = jest.fn(),
) {
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
    drawerOpen,
    setDrawerOpen,
    sidebarPinned,
    persistSidebarPinned,
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
    diffOpen: false,
    changeSummary: { files: [] },
    diffSelectedPath: null,
    diffText: '',
    diffTruncated: false,
    diffLoading: false,
    diffImage: null,
    historyEntries: [],
    historyCommit: null,
    diffSideBySide: false,
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
  };

  return new Proxy(known, {
    get(target, property) {
      return property in target ? target[property as keyof typeof target] : noop;
    },
  }) as unknown as ReturnType<typeof useTetherApp>;
}

function Harness({ initialPinned = false }: { initialPinned?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(initialPinned);
  return (
    <TerminalScreen app={appFixture(drawerOpen, setDrawerOpen, sidebarPinned, setSidebarPinned)} />
  );
}

function setWindowWidth(width: number) {
  Dimensions.set({
    window: { width, height: 800, scale: 1, fontScale: 1 },
    screen: { width, height: 800, scale: 1, fontScale: 1 },
  });
}

function renderHarness(width: number, initialPinned = false) {
  setWindowWidth(width);
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width, height: 800 },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }}
    >
      <AppThemeProvider>
        <Harness initialPinned={initialPinned} />
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
}

function renderTerminal(width: number) {
  return renderHarness(width, false);
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementById: () => null },
  });
});

test('keeps the host drawer collapsed by default at wide desktop widths', () => {
  const view = renderTerminal(1024);

  expect(view.queryByLabelText('Studio host section')).toBeNull();
  expect(view.getByLabelText('Open terminal list')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Open terminal list'));
  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.getByLabelText('Pin sidebar')).toBeTruthy();
});

test('docks the host drawer when sidebarPinned is true', () => {
  const view = renderHarness(1024, true);

  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.queryByLabelText('Open terminal list')).toBeNull();
  expect(view.getByLabelText('Unpin sidebar')).toBeTruthy();
});

test('switches the same host drawer to an overlay below the desktop breakpoint', () => {
  const view = renderTerminal(640);

  expect(view.queryByLabelText('Studio host section')).toBeNull();
  fireEvent.press(view.getByLabelText('Open terminal list'));
  expect(view.getByLabelText('Studio host section')).toBeTruthy();
  expect(view.queryByLabelText('Pin sidebar')).toBeNull();
});
