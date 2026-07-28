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
