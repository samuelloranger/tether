import { sendOsNotification } from './desktopNotifications';
import { checkForUpdates } from './desktopUpdater';
import { OverflowMenu } from './OverflowMenu';
import { type AppPreferences, savePreferences } from './preferences';

/**
 * Every item dismisses the menu except the notifications toggle, whose
 * own label is the result you read, so it stays open.
 */
export function AppOverflowMenu({
  visible,
  align,
  onClose,
  prefs,
  onPrefsChange,
  onRename,
  onAppearance,
  onOpenServerSettings,
}: {
  visible: boolean;
  align: 'start' | 'end';
  onClose: () => void;
  prefs: AppPreferences;
  onPrefsChange: (next: AppPreferences) => void;
  onRename: () => void;
  onAppearance: () => void;
  onOpenServerSettings: () => void;
}) {
  const dismissing = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <OverflowMenu
      visible={visible}
      align={align}
      onClose={onClose}
      onRename={dismissing(onRename)}
      onAppearance={dismissing(onAppearance)}
      notificationsEnabled={prefs.notificationsEnabled}
      onToggleNotifications={() => {
        const next = { ...prefs, notificationsEnabled: !prefs.notificationsEnabled };
        savePreferences(next);
        onPrefsChange(next);
      }}
      onTestNotification={dismissing(() => {
        void sendOsNotification('Tether', 'Test notification');
      })}
      onCheckUpdates={dismissing(() => {
        void checkForUpdates();
      })}
      onOpenSettings={dismissing(onOpenServerSettings)}
    />
  );
}
