import { expect, test } from 'bun:test';
import {
  createServerSettingsDraft,
  patchForDraft,
  validateServerSettingsDraft,
} from './serverSettingsModel';

const config = {
  notify: { enabled: true, url: 'https://ntfy.sh', topic: 'tether', hasToken: true },
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

test('includes the notification token only after an explicit replacement', () => {
  const draft = createServerSettingsDraft(config);
  draft.notify.token = 'new-token';

  expect(patchForDraft(config, draft)).toEqual({ notify: { token: 'new-token' } });
});

test('validates the same user-editable bounds as the server config schema', () => {
  const draft = createServerSettingsDraft(config);
  draft.session.scrollbackRows = 99;
  draft.notify.url = 'not-a-url';

  expect(validateServerSettingsDraft(draft)).toEqual({
    notifyUrl: 'Enter a valid notification URL.',
    scrollbackRows: 'Scrollback must be between 100 and 100000 rows.',
  });
});

test('allows a cleared notification URL when notifications are disabled', () => {
  const draft = createServerSettingsDraft(config);
  draft.notify.enabled = false;
  draft.notify.url = '';
  draft.notify.topic = '';

  expect(validateServerSettingsDraft(draft)).toEqual({});
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
