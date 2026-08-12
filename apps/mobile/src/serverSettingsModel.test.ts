import { expect, test } from 'bun:test';
import {
  createServerSettingsDraft,
  patchForDraft,
  pushStatusHint,
  validateServerSettingsDraft,
} from './serverSettingsModel';

const config = {
  push: { enabled: true },
  pushDevices: 2,
  triggers: { waiting: true, oscNotify: true, exit: true, longJob: true },
  longJobSeconds: 300,
  identity: { name: 'Studio', color: '#89b4fa' },
  session: { defaultShell: 'zsh', defaultCwd: '/work', scrollbackRows: 2000, silenceMs: 15000 },
};

test('builds a patch only for changed settings and never round-trips a redacted token', () => {
  const draft = createServerSettingsDraft(config);
  draft.identity.name = 'Studio Mac';

  expect(patchForDraft(config, draft)).toEqual({ identity: { name: 'Studio Mac' } });
});

test('patches the push toggle without sending the read-only device count', () => {
  const draft = createServerSettingsDraft(config);
  draft.push.enabled = false;
  draft.pushDevices = 99;

  expect(patchForDraft(config, draft)).toEqual({ push: { enabled: false } });
});

test('validates the same user-editable bounds as the server config schema', () => {
  const draft = createServerSettingsDraft(config);
  draft.session.scrollbackRows = 99;

  expect(validateServerSettingsDraft(draft)).toEqual({
    scrollbackRows: 'Scrollback must be between 100 and 100000 rows.',
  });
});

test('the push hint distinguishes off, no devices, and delivering', () => {
  expect(pushStatusHint(false, 2, true)).toContain('Off');
  // Enabled with nothing registered is the state that looks broken, so it must
  // say what to do rather than claim delivery.
  expect(pushStatusHint(true, 0, true)).toContain('no device has registered');
  expect(pushStatusHint(true, 1, true)).toContain('1 device');
  expect(pushStatusHint(true, 2, true)).toContain('2 devices');
  // A non-iOS client can still administer a server that pushes elsewhere.
  expect(pushStatusHint(true, 2, false)).toContain('not this one');
});

test('keeps numeric drafts as strings and parses them only in the patch', () => {
  const draft = createServerSettingsDraft(config);
  draft.longJobSeconds = '60';
  draft.session.scrollbackRows = '500';
  draft.session.silenceMs = '2';

  expect(patchForDraft(config, draft)).toEqual({
    longJobSeconds: 60,
    session: { scrollbackRows: 500, silenceMs: 2000 },
  });

  draft.session.scrollbackRows = '';
  expect(validateServerSettingsDraft(draft).scrollbackRows).toBe(
    'Scrollback must be between 100 and 100000 rows.',
  );
});

test('presents silence in seconds and preserves fractional seconds at the API boundary', () => {
  const draft = createServerSettingsDraft({
    ...config,
    session: { ...config.session, silenceMs: 15500 },
  });

  expect(draft.session.silenceMs).toBe('15.5');

  draft.session.silenceMs = '15.75';
  expect(patchForDraft(config, draft)).toEqual({ session: { silenceMs: 15750 } });
});
