import { type NoiseHandle, pairResponder, reconnectResponder } from './noiseFfi';

/**
 * A transport abstraction the channel reads/writes opaque byte frames over. In
 * production these are WebSocket messages; in tests, in-memory queues.
 */
export interface FrameIO {
  send(frame: Uint8Array): void | Promise<void>;
  recv(): Promise<Uint8Array>;
}

/**
 * Looks a device's static public key up in the registry (Plan 2b's
 * `getDeviceByPubkey`, injected here so this module never imports it). Returns
 * the device object (opaque to the channel) or null to deny.
 */
export type Authorizer = (pubkeyBase64: string) => unknown | null;

export interface PairingHooks {
  psk: Uint8Array;
  confirm: (proposal: { pubkeyBase64: string }) => boolean | Promise<boolean>;
  /**
   * How long the crypto handshake exchange may take before it is abandoned as a
   * stalled/hostile connection. Bounds ONLY the message exchange, never the
   * host-confirm — a human reading a code and typing 'y' is legitimately slow.
   */
  handshakeTimeoutMs?: number;
  /** How long to wait for the host-confirm hook before giving up. */
  confirmTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

/** Reject with a `handshake` ChannelError if `p` does not settle within `ms`. */
function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ChannelError('handshake')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class ChannelError extends Error {
  constructor(public code: 'handshake' | 'rejected') {
    super(code);
    this.name = 'ChannelError';
  }
}

/** A live, authenticated Noise channel. Frames are opaque application payloads. */
export class ServerChannel {
  constructor(
    private handle: NoiseHandle,
    readonly device: unknown,
  ) {}

  seal(app: Uint8Array): Uint8Array {
    return this.handle.seal(app);
  }
  open(wire: Uint8Array): Uint8Array {
    return this.handle.open(wire);
  }
  rekeyOutgoing(): void {
    // Rekey is added to NoiseHandle in a later task; delegate when present.
    (this.handle as unknown as { rekeyOutgoing?: () => void }).rekeyOutgoing?.();
  }
  free(): void {
    this.handle.free();
  }
}

function pubkeyBase64(handle: NoiseHandle): string {
  return Buffer.from(handle.remoteStatic()).toString('base64');
}

/**
 * Accept a device's IK reconnect handshake and authorize it. Completing the
 * handshake proves key possession only — authorization is the injected lookup.
 * On denial NO transport is created and NO application frame is exchanged.
 */
export async function acceptReconnect(
  io: FrameIO,
  serverPriv: Uint8Array,
  authorize: Authorizer,
): Promise<ServerChannel> {
  const handle = reconnectResponder(serverPriv);
  try {
    handle.readMessage(await io.recv()); // -> e, es, s, ss
    await io.send(handle.writeMessage()); // <- e, ee, se
  } catch {
    handle.free();
    throw new ChannelError('handshake');
  }
  if (!handle.isFinished()) {
    handle.free();
    throw new ChannelError('handshake');
  }

  const device = authorize(pubkeyBase64(handle));
  if (device == null) {
    // Fail-closed: never enter transport mode, never read/write an app frame.
    handle.free();
    throw new ChannelError('handshake');
  }

  handle.intoTransport();
  return new ServerChannel(handle, device);
}

/**
 * Accept a device's XXpsk2 pairing handshake, then run the host-confirm hook.
 * Returns the channel and the device's static pubkey (base64) for the caller to
 * enroll into the registry. If confirm returns false, no transport is created.
 */
export async function acceptPairing(
  io: FrameIO,
  serverPriv: Uint8Array,
  hooks: PairingHooks,
): Promise<{ channel: ServerChannel; devicePubkey: string }> {
  const handshakeMs = hooks.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const confirmMs = hooks.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const handle = pairResponder(serverPriv, hooks.psk);
  try {
    // Only the crypto exchange is bounded by the (short) handshake timeout.
    await withTimeout(
      handshakeMs,
      (async () => {
        handle.readMessage(await io.recv()); // -> e
        await io.send(handle.writeMessage()); // <- e, ee, s, es
        handle.readMessage(await io.recv()); // -> s, se
      })(),
    );
  } catch {
    handle.free();
    throw new ChannelError('handshake');
  }
  if (!handle.isFinished()) {
    handle.free();
    throw new ChannelError('handshake');
  }

  const devicePubkey = pubkeyBase64(handle);
  // The host-confirm is a human step, bounded by its own (generous) timeout so a
  // slow 'y' never tears down the socket the device is waiting on for its verdict.
  let ok: boolean;
  try {
    ok = await withTimeout(
      confirmMs,
      Promise.resolve(hooks.confirm({ pubkeyBase64: devicePubkey })),
    );
  } catch {
    handle.free();
    throw new ChannelError('handshake');
  }
  if (!ok) {
    handle.free();
    throw new ChannelError('rejected');
  }

  handle.intoTransport();
  return { channel: new ServerChannel(handle, { pubkey: devicePubkey }), devicePubkey };
}
