import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';
import { validateAddress } from '../address';
import { notify } from '../dialog';
import {
  authHeaders,
  clearLegacyPassword,
  clearPassword,
  getLegacyPassword,
  getPassword,
  setPassword as persistPassword,
} from '../secureConfig';
import { connectionRequestUrl } from './connectionUrl';
import { createHostStore } from './hostStore';

export function useConnectionConfig() {
  const [serverIp, setServerIp] = useState('');
  const [port, setPort] = useState('8085');
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');
  const [setupMode, setSetupMode] = useState<'unknown' | 'create' | 'enter'>('unknown');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [testStatus, setTestStatus] = useState<
    { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; msg: string }
  >({ kind: 'idle' });
  const [isConfiguring, setIsConfiguring] = useState(true);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const hostIdRef = useRef<string | null>(null);
  const hostStoreRef = useRef(
    createHostStore({
      storage: AsyncStorage,
      secrets: {
        get: getPassword,
        set: persistPassword,
        clear: clearPassword,
        getLegacy: getLegacyPassword,
        clearLegacy: clearLegacyPassword,
      },
    }),
  );
  const lastConnectedRef = useRef({ ip: serverIp, port });

  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  useEffect(() => {
    void hostStoreRef.current
      .list()
      .then(async (profiles) => {
        const current = profiles[0];
        if (!current) return;
        hostIdRef.current = current.id;
        const savedPassword = await getPassword(current.id);
        setServerIp(current.host);
        setPort(current.port);
        if (savedPassword) {
          setPassword(savedPassword);
          passwordRef.current = savedPassword;
        }
        if (current.host && savedPassword) {
          lastConnectedRef.current = { ip: current.host, port: current.port };
          readyRef.current = true;
          setIsConfiguring(false);
          setReady(true);
        }
      })
      .catch(() => {});
  }, []);

  const request = (path: string, init: RequestInit = {}) =>
    fetch(connectionRequestUrl(serverIp, port, path), {
      ...init,
      headers: { ...authHeaders(passwordRef.current), ...init.headers },
    });

  const testConnection = async () => {
    const address = validateAddress(serverIp, port);
    if (!address.ok) return setTestStatus({ kind: 'error', msg: address.reason });
    setTestStatus({ kind: 'testing' });
    try {
      const status = await fetch(connectionRequestUrl(serverIp, port, '/api/status'), {
        signal: AbortSignal.timeout(5000),
      });
      if (!status.ok) throw new Error('status');
      const needsSetup = Boolean((await status.json()).needsSetup);
      setSetupMode(needsSetup ? 'create' : 'enter');
      if (!password)
        throw new Error(
          needsSetup ? 'Choose a password for this server.' : 'Enter the server password.',
        );
      if (needsSetup) {
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const setup = await fetch(connectionRequestUrl(serverIp, port, '/api/setup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
          signal: AbortSignal.timeout(5000),
        });
        if (setup.status === 409) throw new Error('Already set up. Enter the existing password.');
        if (!setup.ok) throw new Error('Setup failed — try again.');
      } else {
        const health = await request('/api/health', { signal: AbortSignal.timeout(5000) });
        if (health.status === 401) throw new Error('Wrong password.');
        if (!health.ok) throw new Error(`Server error (${health.status}).`);
      }
      setTestStatus({ kind: 'ok' });
    } catch (error) {
      setTestStatus({
        kind: 'error',
        msg: error instanceof Error ? error.message : 'Unreachable — check the host and port.',
      });
    }
  };

  const saveConfig = async () => {
    try {
      const wasReady = readyRef.current;
      let hostId = hostIdRef.current;
      if (hostId) {
        await hostStoreRef.current.update(hostId, { host: serverIp, port });
      } else {
        const profile = await hostStoreRef.current.create({
          name: serverIp,
          color: '#89b4fa',
          host: serverIp,
          port,
          identityName: '',
        });
        hostId = profile.id;
        hostIdRef.current = hostId;
      }
      await persistPassword(hostId, password);
      const addressChanged =
        serverIp !== lastConnectedRef.current.ip || port !== lastConnectedRef.current.port;
      lastConnectedRef.current = { ip: serverIp, port };
      setIsConfiguring(false);
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
      return { addressChanged, wasReady };
    } catch {
      void notify('Error', 'Failed to save configuration', 'error');
      return { addressChanged: false, wasReady: readyRef.current };
    }
  };

  return {
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    ready,
    lastConnectedRef,
    testConnection,
    saveConfig,
  };
}
