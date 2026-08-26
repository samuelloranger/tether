import { useEffect } from 'react';

export function OverflowMenu({
  visible,
  align = 'end',
  onClose,
  onRename,
  onAppearance,
  notificationsEnabled,
  onToggleNotifications,
  onTestNotification,
  onCheckUpdates,
  onOpenSettings,
}: {
  visible: boolean;
  /** Which side to hang the panel on — the sidebar's trigger is on the left. */
  align?: 'start' | 'end';
  onClose: () => void;
  onRename: () => void;
  onAppearance: () => void;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onTestNotification: () => void;
  onCheckUpdates: () => void;
  onOpenSettings: () => void;
}) {
  // Every other overlay in the app closes on Escape; this one only closed by
  // clicking the scrim, which left the keyboard with no way out.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  if (!visible) return null;
  return (
    <div className={`modal-backdrop overflow-backdrop align-${align}`}>
      <button type="button" className="modal-scrim" aria-label="Close menu" onClick={onClose} />
      <div className="overflow-panel" role="menu">
        <button type="button" className="overflow-row" role="menuitem" onClick={onRename}>
          Rename terminal
        </button>
        <button type="button" className="overflow-row" role="menuitem" onClick={onAppearance}>
          Appearance
        </button>
        <button
          type="button"
          className="overflow-row"
          role="menuitem"
          onClick={onToggleNotifications}
        >
          Notifications {notificationsEnabled ? 'on' : 'off'}
        </button>
        {notificationsEnabled ? (
          <button
            type="button"
            className="overflow-row"
            role="menuitem"
            onClick={onTestNotification}
          >
            Test notification
          </button>
        ) : null}
        <button type="button" className="overflow-row" role="menuitem" onClick={onCheckUpdates}>
          Check for updates
        </button>
        <button type="button" className="overflow-row" role="menuitem" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}
