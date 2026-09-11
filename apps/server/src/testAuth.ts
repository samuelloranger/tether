import { addDevice } from './deviceRegistry';
import { mintToken } from './deviceToken';

export function randomPubkey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

/** Mint a Bearer token for a freshly registered device in the isolated test DB. */
export function testAuthHeaders(label = 'test-device'): Record<string, string> {
  const device = addDevice({ label, pubkey: randomPubkey() });
  return { Authorization: `Bearer ${mintToken(device.id)}` };
}
