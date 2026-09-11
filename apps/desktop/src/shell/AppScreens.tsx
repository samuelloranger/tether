import type { ReactNode } from 'react';
import type { HostProfile } from '@/core/types';
import { DevicesScreen } from '@/host/DevicesScreen';
import { HostsScreen } from '@/host/HostsScreen';
import { PairDeviceScreen } from '@/host/PairDeviceScreen';
import type { AppPreferences } from '@/settings/preferences';
import { ServerSettingsScreen } from '@/settings/ServerSettingsScreen';
import { LocalSettingsScreen } from '@/settings/SettingsScreen';
import type { TetherDesktop } from '@/shell/useTetherDesktop';

export interface AppScreenProps {
  app: TetherDesktop;
  prefs: AppPreferences;
  setPrefs: (prefs: AppPreferences) => void;
  settingsHost: HostProfile | null | undefined;
}

/**
 * The inner element for any non-main screen, or null when main should render.
 *
 * A plain function rather than a component: it has to be able to return null so
 * App can decide to render the main screen instead, and App cannot branch on an
 * already-rendered element. Returning just the inner element also lets App apply
 * the shared `app-shell centered` wrapper and <AlertModal /> once.
 */
export function appScreen({ app, prefs, setPrefs, settingsHost }: AppScreenProps): ReactNode | null {
  if (app.hosts.length === 0 || app.screen === 'pair-device') {
    return (
      <PairDeviceScreen
        onPair={app.pairHost}
        onDone={() => app.setScreen('hosts')}
        onCancel={() => app.setScreen(app.hosts.length > 0 ? 'hosts' : 'main')}
      />
    );
  }

  if (app.screen === 'devices' && settingsHost) {
    return (
      <DevicesScreen
        host={settingsHost}
        onBack={() => {
          app.setSettingsHostId(null);
          app.setScreen('hosts');
        }}
      />
    );
  }

  if (app.screen === 'hosts') {
    return (
      <HostsScreen
        hosts={app.hosts}
        healthByHost={app.healthByHost}
        onBack={() => app.setScreen('main')}
        onAdd={() => app.setScreen('pair-device')}
        onDevices={(hostId) => {
          app.setSettingsHostId(hostId);
          app.setScreen('devices');
        }}
        onRemove={(hostId) => void app.removeHost(hostId)}
        onSelect={app.selectHost}
      />
    );
  }

  if (app.screen === 'local-settings') {
    return <LocalSettingsScreen prefs={prefs} onPrefsChange={setPrefs} onBack={() => app.setScreen('main')} />;
  }

  if (app.screen === 'settings' && settingsHost) {
    return (
      <ServerSettingsScreen
        host={settingsHost}
        health={app.healthByHost[settingsHost.id] ?? 'unknown'}
        onBack={() => {
          app.setSettingsHostId(null);
          app.setScreen('main');
        }}
        onRetry={() => app.retryHost(settingsHost.id)}
        onIdentitySaved={(identity) => {
          void app.updateHostIdentity(settingsHost.id, identity);
        }}
        onConnectionSaved={async (changes) => {
          await app.updateHostConnection(settingsHost.id, changes);
        }}
        onRemoveHost={async () => {
          await app.removeHost(settingsHost.id);
        }}
      />
    );
  }

  return null;
}
