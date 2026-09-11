// Render-only harness for App. `renderToString` never runs effects, so xterm
// never initializes and no Tauri invoke is reached — only render-time code runs.
import type { DrawerSession, HostProfile } from '@/core/types';

const storage = new Map<string, string>();
let uuidCounter = 0;

export function installDomStubs(): void {
  (globalThis as Record<string, unknown>).window = {
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'http://localhost/' },
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  // Pane ids reach the DOM as data-pane-id. Real randomUUID makes every
  // snapshot differ, so ids are counted instead and reset before each render.
  (globalThis as Record<string, unknown>).crypto = { randomUUID: () => `uuid-${uuidCounter++}` };
}

export function resetStubs(): void {
  storage.clear();
  uuidCounter = 0;
}

export const PANE_TREE_KEY = 'tether_pane_tree';

export function seedViews(state: unknown): void {
  storage.set(PANE_TREE_KEY, JSON.stringify(state));
}

export function seedPref(key: string, value: string): void {
  storage.set(key, value);
}

export const HOST: HostProfile = {
  id: 'h1',
  name: 'homelab',
  color: '#3ddc97',
  host: '127.0.0.1',
  port: '8085',
  identityName: 'lab',
  order: 0,
};

export const SESSION_PTY: DrawerSession = {
  hostId: 'h1',
  id: 's1',
  status: 'running',
  last_output_at: null,
  name: 'build',
};

export const SESSION_AGENT: DrawerSession = {
  hostId: 'h1',
  id: 's2',
  status: 'running',
  last_output_at: null,
  name: 'chat',
  kind: 'agent',
};

export function soloViewState(sessionId: string | null) {
  return {
    activeViewId: 'v1',
    views: [
      {
        id: 'v1',
        focusedPaneId: 'p1',
        tree: { kind: 'leaf', id: 'p1', session: sessionId ? { hostId: 'h1', sessionId } : null },
      },
    ],
  };
}

export function splitViewState() {
  return {
    activeViewId: 'v1',
    views: [
      {
        id: 'v1',
        focusedPaneId: 'p1',
        tree: {
          kind: 'branch',
          id: 'b1',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', id: 'p1', session: { hostId: 'h1', sessionId: 's1' } },
          b: { kind: 'leaf', id: 'p2', session: { hostId: 'h1', sessionId: 's2' } },
        },
      },
    ],
  };
}

/** Every field of TetherDesktop, overridable per case. */
export function mockDesktop(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    hosts: [HOST],
    sessions: [],
    healthByHost: { h1: 'reachable' },
    activeHost: HOST,
    activeHostId: 'h1',
    activeSessionId: null,
    activeSessionLabel: 'shell',
    screen: 'main',
    gitOpen: false,
    gitMode: 'drawer',
    setScreen() {},
    setGitOpen() {},
    setGitMode() {},
    settingsHostId: null,
    setSettingsHostId() {},
    selectHost() {},
    selectSession() {},
    newSession: async () => null,
    newAgentChat: async () => null,
    pendingAgentKeys: () => [],
    killSessionById() {},
    renameSessionById() {},
    retryHost() {},
    pairHost() {},
    removeHost() {},
    updateHostIdentity() {},
    updateHostConnection() {},
    handleWsFrame() {},
    ...overrides,
  };
}
