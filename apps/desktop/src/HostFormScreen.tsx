import { useState } from 'react';
import { validateAddress } from './address';
import type { HostProfile } from './hostStore';

interface HostFormScreenProps {
  editing?: HostProfile | null;
  onSave: (input: {
    id?: string;
    name: string;
    host: string;
    port: string;
    password: string;
    confirmPassword?: string;
  }) => Promise<void>;
  onCancel: () => void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: host form keeps TOFU pairing fields together
export function HostFormScreen({ editing, onSave, onCancel }: HostFormScreenProps) {
  const [name, setName] = useState(editing?.name ?? editing?.host ?? '');
  const [host, setHost] = useState(editing?.host ?? '127.0.0.1');
  const [port, setPort] = useState(editing?.port ?? '8085');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probeSetup = async () => {
    const address = validateAddress(host, port);
    if (!address.ok) return;
    try {
      const response = await fetch(`http://${host}:${port}/api/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { needsSetup?: unknown };
      setNeedsSetup(Boolean(body.needsSetup));
    } catch {
      // ignore probe errors
    }
  };

  const submit = async () => {
    const address = validateAddress(host, port);
    if (!address.ok) {
      setError(address.reason);
      return;
    }
    if (!name.trim()) {
      setError('Enter a name for this host.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        id: editing?.id,
        name: name.trim(),
        host,
        port,
        password,
        confirmPassword: needsSetup ? confirmPassword : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save host.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel host-form-panel">
      <button type="button" className="linkish back-link" onClick={onCancel}>
        ← Back
      </button>
      <h1>{editing ? 'Edit host' : 'Add host'}</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Host
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onBlur={() => void probeSetup()}
        />
      </label>
      <label>
        Port
        <input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onBlur={() => void probeSetup()}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={editing ? 'Leave blank to keep current' : ''}
          autoComplete={editing ? 'current-password' : 'new-password'}
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
      <button type="button" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Saving…' : editing ? 'Save' : 'Connect'}
      </button>
    </div>
  );
}
