import { useCallback, useEffect, useState } from 'react';
import { coreNoiseDevicesList, coreNoiseRevoke, type DeviceInfo } from './coreApi';
import { lastSeenText, shortFingerprint } from './devicesText';
import { confirmAction } from './dialog';
import { noiseSessionAddress } from './noiseHosts';
import type { HostProfile } from './types';

interface DevicesScreenProps {
  host: HostProfile;
  onBack: () => void;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; devices: DeviceInfo[] }
  | { kind: 'selfRevoked' };

/**
 * Device management for ONE Noise host, mirroring the iOS `DevicesView`. Lists
 * the host's paired devices over the same authenticated Noise channel the
 * terminal uses (a fresh short-lived management session per action) and revokes
 * them. Only reachable for Noise hosts — see the entry point in HostsScreen.
 */
export function DevicesScreen({ host, onBack }: DevicesScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const address = noiseSessionAddress(host.host, host.port);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    setActionError(null);
    try {
      const devices = await coreNoiseDevicesList(host.id, address);
      setPhase({ kind: 'loaded', devices });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : "Couldn't reach the host.",
      });
    }
  }, [host.id, address]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (device: DeviceInfo) => {
    const confirmed = device.isSelf
      ? await confirmAction(
          'Remove this device?',
          "This will remove THIS device — you'll have to pair again to reconnect.",
          { confirmLabel: 'Remove this device', destructive: true },
        )
      : await confirmAction(
          'Revoke device?',
          `${device.label} will lose access to ${host.name} until it pairs again.`,
          { confirmLabel: 'Revoke', destructive: true },
        );
    if (!confirmed) return;

    setRevoking(true);
    setActionError(null);
    try {
      const verdict = await coreNoiseRevoke(host.id, address, device.id);
      if (!verdict.ok) {
        setActionError(verdict.error ?? 'Revoke failed.');
        return;
      }
      if (device.isSelf) {
        // The server tears the session down once this device is gone; there is
        // nothing left to refresh over.
        setPhase({ kind: 'selfRevoked' });
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Revoke failed.');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="panel settings-panel devices-panel">
      <button type="button" className="linkish back-link" onClick={onBack}>
        ← Back
      </button>
      <h1>Devices</h1>
      <p className="muted">{host.name}</p>

      {phase.kind === 'loading' ? <p className="hint">Loading devices…</p> : null}

      {phase.kind === 'error' ? (
        <section className="settings-section">
          <h2>Couldn't reach the host</h2>
          <p className="error">{phase.message}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </section>
      ) : null}

      {phase.kind === 'selfRevoked' ? (
        <section className="settings-section">
          <p className="success-msg">This device was removed.</p>
          <p className="hint">Pair again to reconnect to {host.name}.</p>
        </section>
      ) : null}

      {phase.kind === 'loaded' ? (
        <section className="settings-section">
          <h2>Paired devices</h2>
          {phase.devices.every((device) => device.isSelf) ? (
            <p className="hint">No other devices paired.</p>
          ) : null}
          <ul className="devices-list">
            {phase.devices.map((device) => (
              <li key={device.id} className="devices-row">
                <div className="devices-row-head">
                  <span className="devices-row-label">{device.label}</span>
                  {device.isSelf ? <span className="devices-self-badge">This device</span> : null}
                </div>
                <span className="mono devices-row-fp">{shortFingerprint(device.fingerprint)}</span>
                <span className="devices-row-seen">{lastSeenText(device)}</span>
                <button
                  type="button"
                  className="secondary small danger devices-revoke"
                  disabled={revoking}
                  onClick={() => void revoke(device)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {actionError ? <p className="error devices-action-error">{actionError}</p> : null}
    </div>
  );
}
