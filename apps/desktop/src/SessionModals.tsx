import { useEffect, useState } from 'react';

export function RenameModal({
  visible,
  value,
  placeholder,
  onChange,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  if (!visible) return null;
  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Dismiss" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <h2 id="rename-title" className="modal-title">
          Rename terminal
        </h2>
        <input
          // biome-ignore lint/a11y/noAutofocus: modal open focuses the rename field
          autoFocus
          className="modal-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={onSubmit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function KillConfirmModal({
  visible,
  sessionLabel,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  sessionLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Dismiss" onClick={onCancel} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="kill-title">
        <h2 id="kill-title" className="modal-title">
          Kill this terminal?
        </h2>
        <p className="modal-body">
          {sessionLabel
            ? `“${sessionLabel}” — the process and saved output will be deleted.`
            : 'The process and saved output will be deleted.'}
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="destructive" onClick={onConfirm}>
            Kill
          </button>
        </div>
      </div>
    </div>
  );
}

export function useSessionModals() {
  const [rename, setRename] = useState<{
    hostId: string;
    sessionId: string;
    text: string;
    placeholder: string;
  } | null>(null);
  const [kill, setKill] = useState<{
    hostId: string;
    sessionId: string;
    label: string;
  } | null>(null);

  return {
    rename,
    kill,
    openRename: (hostId: string, sessionId: string, text: string, placeholder: string) =>
      setRename({ hostId, sessionId, text, placeholder }),
    openKill: (hostId: string, sessionId: string, label: string) =>
      setKill({ hostId, sessionId, label }),
    closeRename: () => setRename(null),
    closeKill: () => setKill(null),
    setRenameText: (text: string) =>
      setRename((current) => (current ? { ...current, text } : null)),
  };
}

export type SessionModals = ReturnType<typeof useSessionModals>;

/**
 * The rename and kill dialogs with their state already wired, so the app shell
 * carries one element instead of two blocks of plumbing.
 */
export function SessionModalHost({
  modals,
  onRename,
  onKill,
}: {
  modals: SessionModals;
  onRename: (hostId: string, sessionId: string, name: string) => void;
  onKill: (hostId: string, sessionId: string) => void;
}) {
  return (
    <>
      <RenameModal
        visible={!!modals.rename}
        value={modals.rename?.text ?? ''}
        placeholder={modals.rename?.placeholder ?? ''}
        onChange={modals.setRenameText}
        onClose={modals.closeRename}
        onSubmit={() => {
          if (!modals.rename) return;
          onRename(modals.rename.hostId, modals.rename.sessionId, modals.rename.text.trim());
          modals.closeRename();
        }}
      />
      <KillConfirmModal
        visible={!!modals.kill}
        sessionLabel={modals.kill?.label ?? ''}
        onCancel={modals.closeKill}
        onConfirm={() => {
          if (!modals.kill) return;
          onKill(modals.kill.hostId, modals.kill.sessionId);
          modals.closeKill();
        }}
      />
    </>
  );
}
