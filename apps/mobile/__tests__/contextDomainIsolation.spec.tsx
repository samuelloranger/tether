import { act, render } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { PopupOverlayProvider } from '../src/PopupOverlay';
import {
  TetherProvider,
  useChrome,
  useConnection,
  useFile,
  useGit,
  usePresentation,
  useSession,
  useTranscript,
  useUi,
  useUpdater,
} from '../src/tether/context';

// The domains exist so that a change in one does not invalidate the others. That
// is a property of the wiring, not of any single module, so it is asserted here:
// before useStableDomain, opening a menu changed the identity of all nine
// domains (the churn was function fields being rebuilt every root render), which
// made the split worthless for rendering.

type Domains = {
  chrome: ReturnType<typeof useChrome>;
  ui: ReturnType<typeof useUi>;
  updater: ReturnType<typeof useUpdater>;
  connection: ReturnType<typeof useConnection>;
  session: ReturnType<typeof useSession>;
  git: ReturnType<typeof useGit>;
  file: ReturnType<typeof useFile>;
  presentation: ReturnType<typeof usePresentation>;
  transcript: ReturnType<typeof useTranscript>;
};

let latest: Domains;

function Probe() {
  latest = {
    chrome: useChrome(),
    ui: useUi(),
    updater: useUpdater(),
    connection: useConnection(),
    session: useSession(),
    git: useGit(),
    file: useFile(),
    presentation: usePresentation(),
    transcript: useTranscript(),
  };
  return <Text>probe</Text>;
}

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function mountProbe() {
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppThemeProvider>
        <PopupOverlayProvider>
          <TetherProvider>
            <View>
              <Probe />
            </View>
          </TetherProvider>
        </PopupOverlayProvider>
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const OTHERS = [
  'chrome',
  'updater',
  'connection',
  'session',
  'git',
  'file',
  'presentation',
  'transcript',
] as const;

test('a ui change leaves every other domain identity untouched', async () => {
  await mountProbe();
  const before = { ...latest };
  await act(async () => {
    latest.ui.setMenuOpen(true);
  });
  expect(latest.ui.menuOpen).toBe(true);
  expect(latest.ui).not.toBe(before.ui);
  for (const key of OTHERS) {
    expect(latest[key]).toBe(before[key]);
  }
});

test('successive changes keep propagating rather than being cached away', async () => {
  await mountProbe();
  await act(async () => {
    latest.ui.setMenuOpen(true);
  });
  await act(async () => {
    latest.ui.setRenameText('abc');
  });
  expect(latest.ui.renameText).toBe('abc');
  expect(latest.ui.menuOpen).toBe(true);
  await act(async () => {
    latest.ui.setMenuOpen(false);
  });
  expect(latest.ui.menuOpen).toBe(false);
});

test('a chrome change invalidates chrome only', async () => {
  await mountProbe();
  const beforeChrome = latest.chrome;
  const beforeUi = latest.ui;
  const beforeGit = latest.git;
  await act(async () => {
    await latest.chrome.changeFontSize(1);
  });
  expect(latest.chrome).not.toBe(beforeChrome);
  expect(latest.ui).toBe(beforeUi);
  expect(latest.git).toBe(beforeGit);
});
