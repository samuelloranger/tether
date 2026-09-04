import { useState } from 'react';
import { parsePairAddress } from './pairAddress';
import { formatPairingInput, normalizePairingCode } from './pairingCode';

type PairStatus =
  | { kind: 'idle' }
  | { kind: 'pairing' }
  | { kind: 'success'; fingerprint: string }
  | { kind: 'error'; message: string };

interface PairDeviceScreenProps {
  onPair: (input: {
    name: string;
    host: string;
    port: string;
    address: string;
    code: string;
  }) => Promise<{ fingerprint: string }>;
  onDone: () => void;
  onCancel: () => void;
}

// The pinned key is a 64-char hex sha256 — the SAME string the host prints as
// its "Server fingerprint". Group it into 4-char blocks (matching the iOS
// client) so it can be read and compared out loud against the host.
function groupFingerprint(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? [hex]).join(' ');
}

export function PairDeviceScreen({ onPair, onDone, onCancel }: PairDeviceScreenProps) {
  const [address, setAddress] = useState('127.0.0.1:8085');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<PairStatus>({ kind: 'idle' });

  const busy = status.kind === 'pairing';
  const done = status.kind === 'success';
  const locked = busy || done;

  const submit = async () => {
    const parsed = parsePairAddress(address);
    if (!parsed.ok) {
      setStatus({ kind: 'error', message: parsed.reason });
      return;
    }
    const normalized = normalizePairingCode(code);
    if (!normalized) {
      setStatus({ kind: 'error', message: 'Enter the full 12-character pairing code.' });
      return;
    }
    setStatus({ kind: 'pairing' });
    try {
      const { fingerprint } = await onPair({
        name: parsed.host,
        host: parsed.host,
        port: parsed.port,
        address: parsed.wsAddress,
        code: normalized,
      });
      setStatus({ kind: 'success', fingerprint });
      // Show the pinned fingerprint, then route on to the paired host.
      window.setTimeout(onDone, 1600);
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Pairing failed.' });
    }
  };

  return (
    <div className="panel host-form-panel">
      <button type="button" className="linkish back-link" onClick={onCancel} disabled={busy}>
        ← Back
      </button>
      <h1>Pair a device</h1>
      <label>
        Host address
        <input
          className="mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={locked}
          placeholder="192.168.1.5:8085"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label>
        Pairing code
        <input
          className="pairing-code-input"
          value={code}
          onChange={(e) => setCode(formatPairingInput(e.target.value))}
          disabled={locked}
          placeholder="7QF4-KM9P-X3TV"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={14}
        />
      </label>
      {status.kind === 'pairing' ? <p className="pairing-status working">Pairing…</p> : null}
      {status.kind === 'success' ? (
        <div className="pairing-status success">
          <p className="success-msg">Paired. Pinned server fingerprint:</p>
          <p className="mono pairing-fingerprint">{groupFingerprint(status.fingerprint)}</p>
        </div>
      ) : null}
      {status.kind === 'error' ? <p className="error">{status.message}</p> : null}
      <button type="button" disabled={locked} onClick={() => void submit()}>
        {busy ? 'Pairing…' : done ? 'Paired' : 'Pair device'}
      </button>
    </div>
  );
}
