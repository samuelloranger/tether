// AES-256-GCM over the notification body. The key is generated on the device
// and shared with this server alone; the relay routes the ciphertext without
// ever holding the key, which is what keeps session titles off the relay.
//
// Wire format: base64( nonce[12] || ciphertext || tag[16] ). GCM's tag is
// appended by WebCrypto, so ciphertext and tag travel together.
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export interface PushContent {
  title: string;
  body: string;
  link?: string;
}

export function generateSecretKeyBase64(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))).toString('base64');
}

export function isValidSecretKey(base64Key: string): boolean {
  try {
    return Buffer.from(base64Key, 'base64').length === KEY_BYTES;
  } catch {
    return false;
  }
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64Key, 'base64');
  if (raw.length !== KEY_BYTES) throw new Error('push secret key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptPushContent(base64Key: string, content: PushContent): Promise<string> {
  const key = await importKey(base64Key);
  // A fresh random nonce per message; reusing one under the same key would
  // leak plaintext relationships and break GCM's integrity guarantee.
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(content));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)]).toString('base64');
}

/** Present so tests can prove round-tripping; the real decrypt runs in the iOS NSE. */
export async function decryptPushContent(base64Key: string, payload: string): Promise<PushContent> {
  const key = await importKey(base64Key);
  const raw = Buffer.from(payload, 'base64');
  const nonce = raw.subarray(0, NONCE_BYTES);
  const sealed = raw.subarray(NONCE_BYTES);
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed);
  return JSON.parse(new TextDecoder().decode(opened)) as PushContent;
}
