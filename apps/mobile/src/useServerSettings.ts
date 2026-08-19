import { useEffect, useMemo, useState } from 'react';
import { validateAddress } from './address';
import type { AdminOperation, SettingsMessage } from './ServerSettingsSections';
import { loadServerConfig, loadServerVersion } from './serverConfig';
import {
  confirmDiscardSettings,
  confirmRemoveHost,
  runAdminOperation,
  saveHostConnection,
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
import type { HostClient } from './tether/hostClient';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';

export type ServerSettingsProps = {
  visible: boolean;
  inline?: boolean;
  host: HostProfile | null;
  client: HostClient | null;
  health: HostHealthStatus;
  onClose: () => void;
  onRetry: () => void;
  onUnauthorized: () => void;
  onIdentitySaved: (identity: ServerConfig['identity']) => void;
  onPasswordChanged: (password: string) => Promise<void>;
  onConnectionSaved: (
    changes: Pick<HostProfile, 'host' | 'port'>,
    replacementPassword?: string,
  ) => Promise<void>;
  onRemoveHost: () => Promise<void>;
};

function useConnectionFields(host: HostProfile | null) {
  const [connectionHost, setConnectionHost] = useState(host?.host ?? '');
  const [connectionPort, setConnectionPort] = useState(host?.port ?? '8085');
  const [replacementPassword, setReplacementPassword] = useState('');
  useEffect(() => {
    setConnectionHost(host?.host ?? '');
    setConnectionPort(host?.port ?? '8085');
    setReplacementPassword('');
  }, [host]);
  const connectionDirty =
    !!host &&
    (connectionHost !== host.host ||
      connectionPort !== host.port ||
      replacementPassword.length > 0);
  const connectionValidation = validateAddress(connectionHost, connectionPort);
  return {
    connectionHost,
    setConnectionHost,
    connectionPort,
    setConnectionPort,
    replacementPassword,
    setReplacementPassword,
    connectionDirty,
    connectionOk: connectionValidation.ok,
    connectionReason: !connectionValidation.ok ? connectionValidation.reason : undefined,
  };
}

type ConnectionFields = ReturnType<typeof useConnectionFields>;

function useSettingsLoad(
  visible: boolean,
  client: HostClient | null,
  health: HostHealthStatus,
  hostName: string | undefined,
) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [draft, setDraft] = useState<ServerSettingsDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<SettingsMessage | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!visible || !client || health === 'unreachable' || health === 'unauthorized') return;
    setLoading(true);
    setMessage(null);
    void Promise.all([loadServerConfig(client), loadServerVersion(client)])
      .then(([nextConfig, nextVersion]) => {
        setConfig(nextConfig);
        const named = hostName
          ? { ...nextConfig, identity: { ...nextConfig.identity, name: hostName } }
          : nextConfig;
        setDraft(createServerSettingsDraft(named));
        setVersion(nextVersion);
      })
      .catch((error) =>
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Could not load settings.',
        }),
      )
      .finally(() => setLoading(false));
  }, [client, health, visible, hostName]);
  return { config, setConfig, draft, setDraft, loading, message, setMessage, version, setVersion };
}

type SettingsLoad = ReturnType<typeof useSettingsLoad>;

function useAdminFields() {
  const [admin, setAdmin] = useState<AdminOperation>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const resetAdmin = () => {
    setAdmin(null);
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
  };
  return {
    admin,
    setAdmin,
    currentPassword,
    setCurrentPassword,
    nextPassword,
    setNextPassword,
    confirmPassword,
    setConfirmPassword,
    adminBusy,
    setAdminBusy,
    resetAdmin,
  };
}

type AdminFields = ReturnType<typeof useAdminFields>;

function useSettingsActions(
  p: ServerSettingsProps,
  load: SettingsLoad,
  connection: ConnectionFields,
  admin: AdminFields,
  dirty: boolean,
  setSaving: (saving: boolean) => void,
) {
  const set = <K extends keyof ServerSettingsDraft>(key: K, value: ServerSettingsDraft[K]) =>
    load.setDraft((current) => (current ? { ...current, [key]: value } : current));
  const close = async () => {
    if (!(await confirmDiscardSettings(dirty))) return;
    p.onClose();
  };
  const save = async () => {
    if (!load.config || !load.draft || !p.client) return;
    await saveServerDraft({
      config: load.config,
      draft: load.draft,
      client: p.client,
      setConfig: load.setConfig,
      setDraft: load.setDraft,
      setSaving,
      setMessage: load.setMessage,
      onIdentitySaved: p.onIdentitySaved,
    });
  };
  const saveConnection = () =>
    saveHostConnection({
      connectionDirty: connection.connectionDirty,
      connectionOk: connection.connectionOk,
      connectionHost: connection.connectionHost,
      connectionPort: connection.connectionPort,
      replacementPassword: connection.replacementPassword,
      setSaving,
      setMessage: load.setMessage,
      setReplacementPassword: connection.setReplacementPassword,
      onConnectionSaved: p.onConnectionSaved,
    });
  const removeHost = async () => {
    if (!(await confirmRemoveHost())) return;
    await p.onRemoveHost();
    p.onClose();
  };
  const sendTest = async () => {
    if (!load.config || !load.draft || !p.client) return;
    await sendSettingsTest(p.client, load.setMessage);
  };
  const runAdmin = () => {
    if (!p.client) return;
    return runAdminOperation({
      client: p.client,
      admin: admin.admin,
      currentPassword: admin.currentPassword,
      nextPassword: admin.nextPassword,
      confirmPassword: admin.confirmPassword,
      onPasswordChanged: p.onPasswordChanged,
      onRetry: p.onRetry,
      setMessage: load.setMessage,
      setAdminBusy: admin.setAdminBusy,
      setVersion: load.setVersion,
      resetAdmin: admin.resetAdmin,
    });
  };
  return { set, close, save, saveConnection, removeHost, sendTest, runAdmin };
}

export function useServerSettings(p: ServerSettingsProps) {
  const load = useSettingsLoad(p.visible, p.client, p.health, p.host?.name);
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
  const actions = useSettingsActions(p, load, connection, admin, dirty, setSaving);
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
    readOnly: p.health === 'unreachable' || !load.draft,
    validationErrors,
    ...actions,
  };
}
