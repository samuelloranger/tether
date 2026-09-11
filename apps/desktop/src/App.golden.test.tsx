import { beforeEach, expect, mock, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import {
  installDomStubs,
  mockDesktop,
  resetStubs,
  SESSION_AGENT,
  SESSION_PTY,
  seedPref,
  seedViews,
  soloViewState,
  splitViewState,
} from '@/shell/appRender.testkit';

installDomStubs();

let desktop = mockDesktop();
mock.module('@/shell/useTetherDesktop', () => ({ useTetherDesktop: () => desktop }));

beforeEach(() => {
  resetStubs();
  desktop = mockDesktop();
});

async function render(): Promise<string> {
  const { App } = await import('@/App');
  return renderToString(<App />);
}

test('1 boot', async () => {
  desktop = mockDesktop({ ready: false });
  expect(await render()).toMatchSnapshot();
});

test('2 no hosts falls through to pair-device', async () => {
  desktop = mockDesktop({ hosts: [], activeHost: null, activeHostId: null });
  expect(await render()).toMatchSnapshot();
});

test('3 pair-device with hosts present', async () => {
  desktop = mockDesktop({ screen: 'pair-device' });
  expect(await render()).toMatchSnapshot();
});

test('4 hosts screen', async () => {
  desktop = mockDesktop({ screen: 'hosts' });
  expect(await render()).toMatchSnapshot();
});

test('5 devices screen', async () => {
  desktop = mockDesktop({ screen: 'devices', settingsHostId: 'h1' });
  expect(await render()).toMatchSnapshot();
});

test('6 server settings screen', async () => {
  desktop = mockDesktop({ screen: 'settings', settingsHostId: 'h1' });
  expect(await render()).toMatchSnapshot();
});

test('7 local settings screen', async () => {
  desktop = mockDesktop({ screen: 'local-settings' });
  expect(await render()).toMatchSnapshot();
});

test('8 main with no sessions', async () => {
  seedViews(soloViewState(null));
  expect(await render()).toMatchSnapshot();
});

test('9 main with one session', async () => {
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1' });
  expect(await render()).toMatchSnapshot();
});

test('10 main with a two-pane split', async () => {
  seedViews(splitViewState());
  desktop = mockDesktop({ sessions: [SESSION_PTY, SESSION_AGENT], activeSessionId: 's1' });
  expect(await render()).toMatchSnapshot();
});

test('11 sidebar docked', async () => {
  seedPref('tether_sidebar_pinned', 'true');
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1' });
  expect(await render()).toMatchSnapshot();
});

test('12 sidebar unpinned', async () => {
  seedPref('tether_sidebar_pinned', 'false');
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1' });
  expect(await render()).toMatchSnapshot();
});

test('13 horizontal tab layout', async () => {
  seedPref('tether_tab_layout', 'horizontal');
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1' });
  expect(await render()).toMatchSnapshot();
});

test('14 git drawer open', async () => {
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1', gitOpen: true, gitMode: 'drawer' });
  expect(await render()).toMatchSnapshot();
});

test('15 git review open', async () => {
  seedViews(soloViewState('s1'));
  desktop = mockDesktop({ sessions: [SESSION_PTY], activeSessionId: 's1', gitOpen: true, gitMode: 'review' });
  expect(await render()).toMatchSnapshot();
});

test('16 agent session pane', async () => {
  seedViews({
    activeViewId: 'v1',
    views: [
      {
        id: 'v1',
        focusedPaneId: 'p1',
        tree: { kind: 'leaf', id: 'p1', session: { hostId: 'h1', sessionId: 's2', kind: 'agent', cwd: '/repo' } },
      },
    ],
  });
  desktop = mockDesktop({ sessions: [SESSION_AGENT], activeSessionId: 's2' });
  expect(await render()).toMatchSnapshot();
});
