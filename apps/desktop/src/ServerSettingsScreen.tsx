import { pushStatusHint, type ServerSettingsDraft } from './serverSettingsModel';
import { type ServerSettingsProps, useServerSettings } from './useServerSettings';

export function ServerSettingsScreen(props: ServerSettingsProps) {
  const s = useServerSettings(props);

  if (props.health === 'unauthorized') {
    return (
      <div className="panel settings-panel server-settings">
        <button type="button" className="linkish back-link" onClick={() => void s.close()}>
          ← Back
        </button>
        <h1>{props.host.name}</h1>
        <p className="error">Unauthorized. Re-enter the password.</p>
        <button type="button" onClick={props.onUnauthorized}>
          Re-enter password
        </button>
      </div>
    );
  }

  if (props.health === 'unreachable') {
    return (
      <div className="panel settings-panel server-settings">
        <button type="button" className="linkish back-link" onClick={() => void s.close()}>
          ← Back
        </button>
        <h1>{props.host.name}</h1>
        <p className="error">Host unreachable.</p>
        <button type="button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="panel settings-panel server-settings">
      <button type="button" className="linkish back-link" onClick={() => void s.close()}>
        ← Sessions
      </button>
      <h1>{props.host.name}</h1>
      {s.version ? <p className="muted">Server {s.version}</p> : null}
      {s.loading && !s.draft ? <p className="muted">Loading…</p> : null}
      {s.message ? (
        <p className={s.message.kind === 'error' ? 'error' : 'success-msg'}>{s.message.text}</p>
      ) : null}

      <section className="settings-section">
        <h2>Connection</h2>
        <label>
          Address
          <input value={s.connectionHost} onChange={(e) => s.setConnectionHost(e.target.value)} />
        </label>
        <label>
          Port
          <input value={s.connectionPort} onChange={(e) => s.setConnectionPort(e.target.value)} />
        </label>
        <label>
          Replace saved password
          <input
            type="password"
            autoComplete="new-password"
            value={s.replacementPassword}
            onChange={(e) => s.setReplacementPassword(e.target.value)}
          />
        </label>
        {!s.connectionOk && s.connectionReason ? (
          <p className="error">{s.connectionReason}</p>
        ) : null}
        <button
          type="button"
          disabled={!s.connectionDirty || !s.connectionOk || s.saving}
          onClick={() => void s.saveConnection()}
        >
          {s.connectionDirty ? 'Save connection' : 'Connection saved'}
        </button>
      </section>

      {s.draft ? <DraftForm s={s} draft={s.draft} /> : null}

      <section className="settings-section">
        <h2>Admin</h2>
        <div className="admin-actions">
          <button type="button" className="secondary" onClick={() => s.setAdmin('password')}>
            Change password
          </button>
          <button type="button" className="secondary" onClick={() => s.setAdmin('update')}>
            Update server
          </button>
          <button type="button" className="secondary" onClick={() => s.setAdmin('restart')}>
            Restart server
          </button>
        </div>
        {s.admin ? (
          <div className="admin-form">
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={s.currentPassword}
                onChange={(e) => s.setCurrentPassword(e.target.value)}
              />
            </label>
            {s.admin === 'password' ? (
              <>
                <label>
                  New password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={s.nextPassword}
                    onChange={(e) => s.setNextPassword(e.target.value)}
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={s.confirmPassword}
                    onChange={(e) => s.setConfirmPassword(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => s.setAdmin(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={s.adminBusy || !s.currentPassword}
                onClick={() => void s.runAdmin()}
              >
                {s.admin === 'password' ? 'Change' : s.admin === 'update' ? 'Update' : 'Restart'}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <button type="button" className="secondary danger" onClick={() => void s.removeHost()}>
        Remove this host
      </button>
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: form sections mirror ServerSettingsSections
function DraftForm({
  s,
  draft,
}: {
  s: ReturnType<typeof useServerSettings>;
  draft: ServerSettingsDraft;
}) {
  return (
    <>
      <section className="settings-section">
        <h2>Name & colour</h2>
        <label>
          Name
          <input
            value={draft.identity.name}
            disabled={s.readOnly}
            onChange={(e) => s.set('identity', { ...draft.identity, name: e.target.value })}
          />
        </label>
        {s.validationErrors.identityName ? (
          <p className="error">{s.validationErrors.identityName}</p>
        ) : null}
        <div className="color-swatches">
          {s.identityColors.map((color) => (
            <button
              key={color}
              type="button"
              className={`color-swatch${draft.identity.color === color ? ' selected' : ''}`}
              style={{ background: color }}
              disabled={s.readOnly}
              aria-label={color}
              onClick={() => s.set('identity', { ...draft.identity, color })}
            />
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>Notifications</h2>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.push.enabled}
            disabled={s.readOnly}
            onChange={(e) => s.set('push', { enabled: e.target.checked })}
          />
          Push to my devices
        </label>
        <p className="hint">{pushStatusHint(draft.push.enabled, draft.pushDevices)}</p>
        {(
          [
            ['waiting', 'Agent needs input'],
            ['done', 'Agent finishes a turn'],
            ['oscNotify', 'Alerts from programs'],
            ['exit', 'Session ends'],
            ['longJob', 'Long command finishes'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="toggle-row">
            <input
              type="checkbox"
              checked={draft.triggers[key]}
              disabled={s.readOnly}
              onChange={(e) => s.set('triggers', { ...draft.triggers, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <label>
          Count a command as long after (seconds)
          <input
            value={draft.longJobSeconds}
            disabled={s.readOnly}
            onChange={(e) => s.set('longJobSeconds', e.target.value)}
          />
        </label>
        {s.validationErrors.longJobSeconds ? (
          <p className="error">{s.validationErrors.longJobSeconds}</p>
        ) : null}
        <button
          type="button"
          className="secondary"
          disabled={s.readOnly || draft.pushDevices === 0}
          onClick={() => void s.sendTest()}
        >
          Send test notification
        </button>
      </section>

      <section className="settings-section">
        <h2>Sessions</h2>
        <p className="hint">Changes apply to newly started sessions.</p>
        <label>
          Default shell
          <input
            value={draft.session.defaultShell}
            disabled={s.readOnly}
            onChange={(e) => s.set('session', { ...draft.session, defaultShell: e.target.value })}
          />
        </label>
        <label>
          Default directory
          <input
            value={draft.session.defaultCwd}
            disabled={s.readOnly}
            onChange={(e) => s.set('session', { ...draft.session, defaultCwd: e.target.value })}
          />
        </label>
        <label>
          Scrollback rows
          <input
            value={draft.session.scrollbackRows}
            disabled={s.readOnly}
            onChange={(e) => s.set('session', { ...draft.session, scrollbackRows: e.target.value })}
          />
        </label>
        {s.validationErrors.scrollbackRows ? (
          <p className="error">{s.validationErrors.scrollbackRows}</p>
        ) : null}
        <label>
          Silence threshold (seconds)
          <input
            value={draft.session.silenceMs}
            disabled={s.readOnly}
            onChange={(e) => s.set('session', { ...draft.session, silenceMs: e.target.value })}
          />
        </label>
        {s.validationErrors.silenceMs ? (
          <p className="error">{s.validationErrors.silenceMs}</p>
        ) : null}
        <button
          type="button"
          disabled={
            s.readOnly || !s.dirty || Object.keys(s.validationErrors).length > 0 || s.saving
          }
          onClick={() => void s.save()}
        >
          Save settings
        </button>
      </section>
    </>
  );
}
