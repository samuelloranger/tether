import { expect, test } from 'bun:test';
import { sidebarLayout } from './preferences';
import {
  createServerSettingsDraft,
  patchForDraft,
  pushStatusHint,
  validateServerSettingsDraft,
} from './serverSettingsModel';

const config = {
  push: { enabled: true },
  pushDevices: 2,
  triggers: { waiting: true, done: false, oscNotify: true, exit: true, longJob: true },
  longJobSeconds: 300,
  identity: { name: 'Studio', color: '#89b4fa' },
  session: { defaultShell: 'zsh', defaultCwd: '/work', scrollbackRows: 2000, silenceMs: 15000 },
};

test('builds a patch only for changed settings', () => {
  const draft = createServerSettingsDraft(config);
  draft.identity.name = 'Studio Mac';
  expect(patchForDraft(config, draft)).toEqual({ identity: { name: 'Studio Mac' } });
});

test('patches push without sending device count', () => {
  const draft = createServerSettingsDraft(config);
  draft.push.enabled = false;
  draft.pushDevices = 99;
  expect(patchForDraft(config, draft)).toEqual({ push: { enabled: false } });
});

test('identity key absent when only triggers change — rename gate', () => {
  const draft = createServerSettingsDraft(config);
  draft.triggers.waiting = false;
  const patch = patchForDraft(config, draft);
  expect(patch.identity).toBeUndefined();
  expect(patch.triggers).toEqual({ waiting: false });
});

test('validates scrollback bounds', () => {
  const draft = createServerSettingsDraft(config);
  draft.session.scrollbackRows = '99';
  expect(validateServerSettingsDraft(draft)).toEqual({
    scrollbackRows: 'Scrollback must be between 100 and 100000 rows.',
  });
});

test('push hint covers off / no devices / delivering', () => {
  expect(pushStatusHint(false, 2)).toContain('Off');
  expect(pushStatusHint(true, 0)).toContain('no device has registered');
  expect(pushStatusHint(true, 2)).toContain('2 devices');
});

test('sidebar layout helpers', () => {
  expect(sidebarLayout({ wide: true, sidebarPinned: false, drawerOpen: false })).toEqual({
    docked: false,
    visible: false,
    showMenuButton: true,
    showTabBar: false,
  });
  expect(sidebarLayout({ wide: true, sidebarPinned: true, drawerOpen: false })).toEqual({
    docked: true,
    visible: true,
    showMenuButton: false,
    showTabBar: false,
  });
  expect(sidebarLayout({ wide: false, sidebarPinned: true, drawerOpen: true })).toEqual({
    docked: false,
    visible: true,
    showMenuButton: false,
    showTabBar: false,
  });
});

test('horizontal tab layout hides the sidebar at any width', () => {
  expect(
    sidebarLayout({
      wide: true,
      sidebarPinned: true,
      drawerOpen: true,
      tabLayout: 'horizontal',
    }),
  ).toEqual({
    docked: false,
    visible: false,
    showMenuButton: false,
    showTabBar: true,
  });
  expect(
    sidebarLayout({
      wide: false,
      sidebarPinned: false,
      drawerOpen: true,
      tabLayout: 'horizontal',
    }),
  ).toEqual({
    docked: false,
    visible: false,
    showMenuButton: false,
    showTabBar: true,
  });
});
