import { useState } from 'react';
import { validateAddress } from './address';
import {
  createHostClient,
  type HostConfig,
  loadStoredConfig,
  saveStoredConfig,
  testConnection,
} from './hostClient';

interface ConnectScreenProps {
  onConnected: (config: HostConfig) => void;
}

export function ConnectScreen({ onConnected }: ConnectScreenProps) {
  const stored = loadStoredConfig();
  const [host, setHost] = useState(stored.host ?? '127.0.0.1');
  const [port, setPort] = useState(stored.port ?? '8085');
  const [password, setPassword] = useState(stored.password ?? '');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probeSetup = async () => {
    const address = validateAddress(host, port);
    if (!address.ok) {
      setError(address.reason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createHostClient({ host, port, password: '' });
      const status = await client.get('/api/status', { signal: AbortSignal.timeout(5000) });
      if (!status.ok) throw new Error('Server is unavailable.');
      const body = (await status.json()) as { needsSetup?: unknown };
      setNeedsSetup(Boolean(body.needsSetup));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unreachable — check the host and port.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const address = validateAddress(host, port);
    if (!address.ok) {
      setError(address.reason);
      return;
    }
    setBusy(true);
    setError(null);
    const config: HostConfig = { host, port, password };
    const client = createHostClient(config);
    const result = await testConnection(client, password, confirmPassword);
    setBusy(false);
    if (!result.ok) {
      setNeedsSetup(result.needsSetup);
      setError(result.msg);
      return;
    }
    saveStoredConfig(config);
    onConnected(config);
  };

  return (
    <div className="panel connect-panel">
      <h1>Tether</h1>
      <p className="muted">Connect to your remote shell server.</p>
      <label>
        Host
        <input value={host} onChange={(e) => setHost(e.target.value)} onBlur={probeSetup} />
      </label>
      <label>
        Port
        <input value={port} onChange={(e) => setPort(e.target.value)} onBlur={probeSetup} />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      {needsSetup ? (
        <label>
          Confirm password
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <button type="button" disabled={busy} onClick={connect}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}
