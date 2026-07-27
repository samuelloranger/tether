import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { TerminalViewProps } from '../src/TerminalView.types';

// This is the test that both v2.2.1 and v2.3.1 needed and did not have.
//
// Typing on mobile does NOT go through the hidden RN TextInput — xterm's helper
// textarea inside the renderer WebView owns the soft keyboard, so characters
// arrive as renderer `input` events. Wiring that prop to the raw sender instead
// of the modifier-aware one is invisible on screen, invisible to a unit test of
// the sender, and ships as "Ctrl+C types a literal c". So: drive the renderer's
// input callback for real and assert on the bytes that reach the socket.

const sockets: { sent: string[]; handlers: Record<string, (arg?: unknown) => void> }[] = [];
let rendererProps: TerminalViewProps | null = null;

jest.mock('../src/wsTransport', () => ({
  openTerminalSocket: (
    _url: string,
    _password: string,
    handlers: { onOpen: () => void; onMessage: (d: string) => void; onClose: () => void },
  ) => {
    const socket = { sent: [] as string[], handlers: handlers as never };
    sockets.push(socket);
    handlers.onOpen();
    return { send: (text: string) => socket.sent.push(text), close: () => handlers.onClose() };
  },
  wsUrl: () => 'ws://test/api/ws',
  httpBase: () => 'http://test',
  previewUrl: () => 'http://test/preview',
}));

// Stand-in for the renderer WebView: captures the props TerminalScreen wires to
// it so the test can fire `input` exactly as the real page does.
jest.mock('../src/TerminalView', () => {
  const { View } = require('react-native');
  return {
    TerminalView: (props: TerminalViewProps) => {
      rendererProps = props;
      return <View testID="terminal-renderer" />;
    },
  };
});

jest.mock('../src/secureConfig', () => ({
  getPassword: jest.fn(async () => 'hunter2'),
  setPassword: jest.fn(async () => undefined),
  authHeaders: () => ({}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppThemeProvider } from '../src/AppThemeProvider';
import { TerminalScreen } from '../src/TerminalScreen';
import { useTetherApp } from '../src/useTetherApp';

function Harness() {
  const app = useTetherApp();
  return <TerminalScreen app={app} />;
}

async function mountTerminal() {
  // Both an address and a stored password are required for the app to leave the
  // setup screen and auto-connect (see loadConfig).
  await AsyncStorage.setItem('tether_server_ip', '127.0.0.1');
  await AsyncStorage.setItem('tether_port', '8085');
  // SafeAreaProvider needs a real frame; without initialMetrics useSafeAreaInsets
  // throws under the test renderer (no native layout pass).
  const view = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <AppThemeProvider>
        <Harness />
      </AppThemeProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await waitFor(() => expect(rendererProps).not.toBeNull());
  return view;
}

function sentInput() {
  return sockets
    .flatMap((s) => s.sent)
    .map((raw) => JSON.parse(raw))
    .filter((msg) => msg.type === 'input')
    .map((msg) => msg.text);
}

beforeEach(() => {
  sockets.length = 0;
  rendererProps = null;
  jest.clearAllMocks();
});

test('a character typed into the renderer reaches the PTY unchanged', async () => {
  await mountTerminal();
  rendererProps?.onInput('c');
  expect(sentInput()).toEqual(['c']);
});

test('Ctrl armed turns the next typed character into a control code', async () => {
  const view = await mountTerminal();
  fireEvent.press(view.getByLabelText('Control modifier'));
  rendererProps?.onInput('c');
  expect(sentInput()).toEqual(['\x03']);
});

test('Ctrl is consumed, so the character after it is literal again', async () => {
  const view = await mountTerminal();
  fireEvent.press(view.getByLabelText('Control modifier'));
  rendererProps?.onInput('c');
  rendererProps?.onInput('c');
  expect(sentInput()).toEqual(['\x03', 'c']);
});

test('a utility-bar key consumes Ctrl instead of leaving it armed', async () => {
  const view = await mountTerminal();
  fireEvent.press(view.getByLabelText('Control modifier'));
  fireEvent.press(view.getByLabelText('Tab'));
  rendererProps?.onInput('c');
  // Tab has no Ctrl encoding, so it passes through — but it must still disarm,
  // or the next typed letter is silently rewritten.
  expect(sentInput()).toEqual(['\t', 'c']);
});

test('Ctrl modifies a cursor key from the renderer into its CSI form', async () => {
  const view = await mountTerminal();
  fireEvent.press(view.getByLabelText('Control modifier'));
  rendererProps?.onInput('\x1b[C');
  expect(sentInput()).toEqual(['\x1b[1;5C']);
});

test('holding backspace accelerates to word delete', async () => {
  await mountTerminal();
  // The renderer emits one \x7f per key repeat. Below the streak threshold each
  // stays a single-character delete; past it they become Ctrl+W (tty werase),
  // which is the behaviour that silently disappeared when the WebView took over
  // input from the hidden capture field.
  for (let i = 0; i <= 16; i++) rendererProps?.onInput('\x7f');
  const sent = sentInput();
  expect(sent.slice(0, 15)).toEqual(Array(15).fill('\x7f'));
  expect(sent.at(-1)).toBe('\x17');
});

test('a bar key between backspaces breaks the streak', async () => {
  const view = await mountTerminal();
  for (let i = 0; i <= 16; i++) rendererProps?.onInput('\x7f');
  fireEvent.press(view.getByLabelText('Esc'));
  rendererProps?.onInput('\x7f');
  expect(sentInput().at(-1)).toBe('\x7f');
});
