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
 * Accepts a device's IK reconnect, authorizes it against the registry, and marks it seen.
 * On an unknown/revoked key, `acceptReconnect` already refused — this rethrows that.
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
