import { acceptReconnect, type FrameIO, type ServerChannel } from './noiseChannel';

/**
 * Dependencies for a reconnect: the registry lookup (the authorization gate —
 * IK completion alone is not authorization) and the last-seen touch.
 */
export interface ReconnectDeps {
  getDeviceByPubkey: (pubkey: string) => { id: string; pubkey: string } | null;
  touchDevice: (pubkey: string, address?: string) => void;
  address?: string;
}

/**
 * Accept a device's IK reconnect over `io`, authorize it against the registry,
 * and mark it seen. On an unknown/revoked key, `acceptReconnect` has already
 * refused before any transport — this rethrows that.
 */
export async function runReconnect(
  io: FrameIO,
  serverPriv: Uint8Array,
  deps: ReconnectDeps,
): Promise<{ channel: ServerChannel; device: { id: string; pubkey: string } }> {
  const channel = await acceptReconnect(io, serverPriv, (pubkey) => deps.getDeviceByPubkey(pubkey));
  const device = channel.device as { id: string; pubkey: string };
  deps.touchDevice(device.pubkey, deps.address);
  return { channel, device };
}
