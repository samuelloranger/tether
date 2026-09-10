import { useEffect, useMemo, useState } from 'react';
import { validateAddress } from './address';
import { loadServerConfig, loadServerVersion } from './serverConfig';
import {
  type AdminOperation,
  confirmDiscardSettings,
  confirmRemoveHost,
  runAdminOperation,
  type SettingsMessage,
  saveServerDraft,
  sendSettingsTest,
} from './serverSettingsActions';
import {
  createServerSettingsDraft,
  isServerSettingsDirty,
  type ServerConfig,
  type ServerSettingsDraft,
  validateServerSettingsDraft,
} from './serverSettingsModel';
import type { HostHealthStatus, HostProfile } from './types';

export type ServerSettingsProps = {
  host: HostProfile;
  health: HostHealthStatus;
  onBack: () => void;
  onRetry: () => void;
  onIdentitySaved: (identity: ServerConfig['identity']) => void;
  onConnectionSaved: (changes: Pick<HostProfile, 'host' | 'port'>) => Promise<void>;
  onRemoveHost: () => Promise<void>;
};

const IDENTITY_COLORS = [
  '#89b4fa',
  '#cba6f7',
  '#f38ba8',
  '#a6e3a1',
  '#fab387',
  '#94e2d5',
  '#f9e2af',
];

function useConnectionFields(host: HostProfile) {
  const [connectionHost, setConnectionHost] = useState(host.host);
  const [connectionPort, setConnectionPort] = useState(host.port);
  useEffect(() => {
    setConnectionHost(host.host);
    setConnectionPort(host.port);
  }, [host]);
  const connectionDirty = connectionHost !== host.host || connectionPort !== host.port;
  const connectionValidation = validateAddress(connectionHost, connectionPort);
  return {
    connectionHost,
    setConnectionHost,
    connectionPort,
    setConnectionPort,
    connectionDirty,
    connectionOk: connectionValidation.ok,
    connectionReason: !connectionValidation.ok ? connectionValidation.reason : undefined,
  };
}

function useSettingsLoad(host: HostProfile, health: HostHealthStatus) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [draft, setDraft] = useState<ServerSettingsDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<SettingsMessage | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  // host.name refreshes the settings header when the profile is renamed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: host.name is a reload trigger
  useEffect(() => {
    if (health === 'unreachable' || health === 'unauthorized') return;
    setLoading(true);
    setMessage(null);
    void Promise.all([loadServerConfig(host.id), loadServerVersion(host.id)])
      .then(([nextConfig, nextVersion]) => {
        setConfig(nextConfig);
        // Seed from the SERVER's identity, not host.name: else patchForDraft sees identity
        // changed and saving any field renames the server. Mirror of the iOS trap (46c1c78).
        setDraft(createServerSettingsDraft(nextConfig));
        setVersion(nextVersion);
      })
      .catch((error) =>
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Could not load settings.',
        }),
      )
      .finally(() => setLoading(false));
  }, [host.id, host.name, health]);
  return { config, setConfig, draft, setDraft, loading, message, setMessage, version, setVersion };
}

function useAdminFields() {
  const [admin, setAdmin] = useState<AdminOperation>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const resetAdmin = () => {
    setAdmin(null);
  };
  return {
    admin,
    setAdmin,
    adminBusy,
    setAdminBusy,
    resetAdmin,
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: settings hook mirrors mobile useServerSettings composition
export function useServerSettings(p: ServerSettingsProps) {
  const load = useSettingsLoad(p.host, p.health);
  const connection = useConnectionFields(p.host);
  const admin = useAdminFields();
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(
    () => !!load.config && !!load.draft && isServerSettingsDirty(load.config, load.draft),
    [load.config, load.draft],
  );
  const validationErrors = useMemo(
    () => (load.draft ? validateServerSettingsDraft(load.draft) : {}),
    [load.draft],
  );
  const set = <K extends keyof ServerSettingsDraft>(key: K, value: ServerSettingsDraft[K]) =>
    load.setDraft((current) => (current ? { ...current, [key]: value } : current));

  return {
    ...connection,
    config: load.config,
    draft: load.draft,
    loading: load.loading,
    message: load.message,
    version: load.version,
    saving,
    ...admin,
    dirty,
    validationErrors,
    readOnly: p.health === 'unreachable' || !load.draft,
    identityColors: IDENTITY_COLORS,
    set,
    close: async () => {
      if (!(await confirmDiscardSettings(dirty))) return;
      p.onBack();
    },
    save: async () => {
      if (!load.config || !load.draft) return;
      await saveServerDraft({
        hostId: p.host.id,
        config: load.config,
        draft: load.draft,
        setConfig: load.setConfig,
        setDraft: load.setDraft,
        setSaving,
        setMessage: load.setMessage,
        onIdentitySaved: p.onIdentitySaved,
      });
    },
    saveConnection: async () => {
      if (!connection.connectionDirty || !connection.connectionOk) return;
      setSaving(true);
      load.setMessage(null);
      try {
        await p.onConnectionSaved({
          host: connection.connectionHost.trim(),
          port: connection.connectionPort.trim(),
        });
        load.setMessage({ kind: 'success', text: 'Connection saved.' });
      } catch (error) {
        load.setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Could not save the connection.',
        });
      } finally {
        setSaving(false);
      }
    },
    removeHost: async () => {
      if (!(await confirmRemoveHost())) return;
      await p.onRemoveHost();
      p.onBack();
    },
    sendTest: () => sendSettingsTest(p.host.id, load.setMessage),
    runAdmin: () =>
      runAdminOperation({
        hostId: p.host.id,
        admin: admin.admin,
        onRetry: p.onRetry,
        setMessage: load.setMessage,
        setAdminBusy: admin.setAdminBusy,
        setVersion: load.setVersion,
        resetAdmin: admin.resetAdmin,
      }),
  };
}
