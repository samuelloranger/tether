// Minimal DER/ASN.1 writer plus a self-signed X.509 v3 generator.
//
// Why hand-rolled: the server ships as a single `bun build --compile` binary, so
// anything here has to work with zero files on disk and zero native modules. The
// alternatives were shelling out to `openssl` (not guaranteed present, and a
// process spawn on first boot) or adding a dependency that would ride along in
// every user's binary. Node's crypto gives us the keypair, the SPKI encoding and
// the signature; the ~150 lines below are only the certificate envelope.
//
// Everything in this module is pure (given a keypair), so it is testable without
// binding a socket.

import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

// --- DER primitives ---------------------------------------------------------

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  let rest = n;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), len(body.length), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);
const octetString = (body: Uint8Array) => tlv(0x04, body);
const boolean = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00));
const utf8String = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const ia5String = (s: string) => tlv(0x16, new TextEncoder().encode(s));
const explicit = (n: number, ...parts: Uint8Array[]) => tlv(0xa0 | n, ...parts);

// Unsigned big-endian integer, with the leading 0x00 DER requires when the top
// bit is set (otherwise it would decode as negative).
function integer(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  const needsPad = (trimmed[0] ?? 0) & 0x80;
  return tlv(0x02, needsPad ? concat(Uint8Array.of(0), trimmed) : trimmed);
}

function smallInteger(value: number): Uint8Array {
  return tlv(0x02, Uint8Array.of(value));
}

// BIT STRING with zero unused trailing bits.
function bitString(body: Uint8Array): Uint8Array {
  return tlv(0x03, concat(Uint8Array.of(0), body));
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

const OID = {
  commonName: '2.5.4.3',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

// UTCTime — YYMMDDHHMMSSZ. Only representable through 2049, which is well past
// any lifetime we hand out; it throws rather than wrap the two-digit year, so a
// future change to CERT_VALID_DAYS fails loudly instead of emitting a 1926 cert.
export function utcTime(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new Error(`UTCTime cannot encode year ${year}`);
  const p = (n: number) => String(n).padStart(2, '0');
  const s =
    `${p(year % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
}

// --- SAN --------------------------------------------------------------------

export function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

// Only the forms we actually emit: full 8-group hex, or a single `::` run.
export function parseIpv6(text: string): Uint8Array | null {
  const zoneless = text.split('%')[0];
  if (!zoneless.includes(':')) return null;
  const [head, tail, ...extra] = zoneless.split('::');
  if (extra.length > 0) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const all = [...left, ...Array(fill).fill('0'), ...right];
  if (all.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null;
    const n = Number.parseInt(all[i], 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

// GeneralName: dNSName is [2] IA5String, iPAddress is [7] OCTET STRING.
function generalName(name: string): Uint8Array {
  const v4 = parseIpv4(name);
  if (v4) return tlv(0x87, v4);
  const v6 = parseIpv6(name);
  if (v6) return tlv(0x87, v6);
  return tlv(0x82, ia5String(name).subarray(2));
}

// --- Certificate ------------------------------------------------------------

export type SelfSignedInput = {
  commonName: string;
  /** DNS names and IP literals for the SAN. Duplicates and blanks are dropped. */
  altNames: string[];
  notBefore: Date;
  notAfter: Date;
  /** Injectable for tests; defaults to a fresh P-256 keypair. */
  keyPair?: { publicKey: KeyObject; privateKey: KeyObject };
  /** Injectable for tests; defaults to 16 random bytes. */
  serialNumber?: Uint8Array;
};

export type SelfSignedCert = {
  certPem: string;
  keyPem: string;
  certDer: Uint8Array;
  /** Lowercase hex SHA-256 over the certificate DER, i.e. the pinned value. */
  fingerprintSha256: string;
};

export function normalizeAltNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function certFingerprint(certDer: Uint8Array): string {
  return createHash('sha256').update(certDer).digest('hex');
}

export function generateSelfSignedCert(input: SelfSignedInput): SelfSignedCert {
  const { publicKey, privateKey } =
    input.keyPair ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  // subjectKeyIdentifier. RFC 5280's first method hashes the public key BIT
  // STRING contents; we hash the whole SPKI instead, which is the same kind of
  // unique-per-key value. It matters only for chain building, and a self-signed
  // leaf with no chain never uses it — pinning is what establishes trust here.
  const skid = createHash('sha1').update(spki).digest();

  const name = seq(set(seq(oid(OID.commonName), utf8String(input.commonName))));
  const sigAlg = seq(oid(OID.ecdsaWithSha256));
  const serial = integer(input.serialNumber ?? crypto.getRandomValues(new Uint8Array(16)));

  const altNames = normalizeAltNames(input.altNames);
  const extensions: Uint8Array[] = [
    // basicConstraints, critical: not a CA.
    seq(oid(OID.basicConstraints), boolean(true), octetString(seq())),
    // keyUsage, critical: digitalSignature | keyEncipherment.
    seq(oid(OID.keyUsage), boolean(true), octetString(tlv(0x03, Uint8Array.of(0x01, 0xa0)))),
    seq(oid(OID.extKeyUsage), octetString(seq(oid(OID.serverAuth)))),
    seq(oid(OID.subjectKeyIdentifier), octetString(octetString(new Uint8Array(skid)))),
  ];
  if (altNames.length > 0) {
    extensions.push(seq(oid(OID.subjectAltName), octetString(seq(...altNames.map(generalName)))));
  }

  const tbs = seq(
    explicit(0, smallInteger(2)), // v3
    serial,
    sigAlg,
    name, // issuer == subject (self-signed)
    seq(utcTime(input.notBefore), utcTime(input.notAfter)),
    name,
    spki,
    explicit(3, seq(...extensions)),
  );

  const signature = new Uint8Array(createSign('SHA256').update(tbs).sign(privateKey));
  const certDer = seq(tbs, sigAlg, bitString(signature));

  return {
    certPem: pem('CERTIFICATE', certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certDer,
    fingerprintSha256: certFingerprint(certDer),
  };
}
