import { createSign } from 'node:crypto';

export interface ApnsKey {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
}

const b64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');

// APNs rejects tokens older than 1 hour and throttles per-push minting, so the
// signature is cached; 50 minutes leaves margin for clock skew against Apple's edge.
const TOKEN_TTL_SECONDS = 50 * 60;

export function signApnsJwt(key: ApnsKey, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: key.keyId, typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: nowSeconds }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  // APNs expects a JOSE (r||s) signature; Node emits DER unless told otherwise.
  const signature = signer.sign({ key: key.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

export class ApnsTokenCache {
  private token: string | null = null;
  private issuedAt = 0;

  constructor(
    private readonly key: ApnsKey,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get(): string {
    const now = this.now();
    if (this.token === null || now - this.issuedAt >= TOKEN_TTL_SECONDS) {
      this.token = signApnsJwt(this.key, now);
      this.issuedAt = now;
    }
    return this.token;
  }
}
