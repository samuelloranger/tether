import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import {
  certFingerprint,
  generateSelfSignedCert,
  normalizeAltNames,
  parseIpv4,
  parseIpv6,
  utcTime,
} from './x509';

const oneYear = 365 * 86_400_000;

function makeCert(altNames: string[] = ['localhost', '127.0.0.1']) {
  const now = Date.now();
  return generateSelfSignedCert({
    commonName: 'tether-test',
    altNames,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + oneYear),
  });
}

describe('DER encoding helpers', () => {
  test('parses dotted-quad IPv4 and rejects the rest', () => {
    expect(Array.from(parseIpv4('192.168.1.50') ?? [])).toEqual([192, 168, 1, 50]);
    expect(Array.from(parseIpv4('0.0.0.0') ?? [])).toEqual([0, 0, 0, 0]);
    expect(parseIpv4('192.168.1.256')).toBeNull();
    expect(parseIpv4('192.168.1')).toBeNull();
    expect(parseIpv4('localhost')).toBeNull();
    expect(parseIpv4('::1')).toBeNull();
  });

  test('parses IPv6, including a compressed run', () => {
    expect(Array.from(parseIpv6('::1') ?? [])).toEqual([...Array(15).fill(0), 1]);
    const full = parseIpv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(Array.from(full ?? []).slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseIpv6('2001:db8::1')).not.toBeNull();
    // A zone index has no SAN representation, but must not crash the parser.
    expect(parseIpv6('fe80::1%eth0')).not.toBeNull();
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6('::1::2')).toBeNull();
    expect(parseIpv6('nope')).toBeNull();
  });

  test('UTCTime is YYMMDDHHMMSSZ and refuses years it cannot represent', () => {
    const der = utcTime(new Date('2026-08-25T07:06:05Z'));
    expect(der[0]).toBe(0x17);
    expect(new TextDecoder().decode(der.subarray(2))).toBe('260825070605Z');
    expect(() => utcTime(new Date('2050-01-01T00:00:00Z'))).toThrow(/2050/);
  });

  test('normalizeAltNames drops blanks and case-insensitive duplicates, keeping order', () => {
    expect(normalizeAltNames(['localhost', ' ', 'LOCALHOST', 'a.local', 'localhost'])).toEqual([
      'localhost',
      'a.local',
    ]);
  });
});

describe('generateSelfSignedCert', () => {
  test('produces a certificate a real X.509 parser accepts', () => {
    const cert = makeCert(['localhost', '127.0.0.1', '::1', 'box.local', '192.168.1.50']);
    const parsed = new X509Certificate(cert.certPem);
    expect(parsed.subject).toContain('CN=tether-test');
    // Self-signed: issuer is the subject, and the cert verifies under its own key.
    expect(parsed.issuer).toBe(parsed.subject);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.ca).toBe(false);
  });

  test('carries every alt name, DNS and IP alike', () => {
    const cert = makeCert(['localhost', '127.0.0.1', '::1', 'box.local', '192.168.1.50']);
    const san = new X509Certificate(cert.certPem).subjectAltName ?? '';
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('DNS:box.local');
    expect(san).toContain('IP Address:127.0.0.1');
    expect(san).toContain('IP Address:192.168.1.50');
    // Node renders ::1 fully expanded.
    expect(san).toContain('0:0:0:0:0:0:0:1');
  });

  test('omits the SAN extension entirely when there are no names', () => {
    const cert = makeCert([]);
    expect(new X509Certificate(cert.certPem).subjectAltName).toBeUndefined();
  });

  test('fingerprint matches what an independent parser computes over the DER', () => {
    const cert = makeCert();
    const parsed = new X509Certificate(cert.certPem);
    expect(cert.fingerprintSha256).toBe(parsed.fingerprint256.replaceAll(':', '').toLowerCase());
    expect(cert.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(certFingerprint(new Uint8Array(parsed.raw))).toBe(cert.fingerprintSha256);
  });

  test('validity window is the one requested', () => {
    const notBefore = new Date('2026-01-02T03:04:05Z');
    const notAfter = new Date('2036-01-02T03:04:05Z');
    const cert = generateSelfSignedCert({
      commonName: 'x',
      altNames: [],
      notBefore,
      notAfter,
    });
    const parsed = new X509Certificate(cert.certPem);
    expect(new Date(parsed.validFrom).getTime()).toBe(notBefore.getTime());
    expect(new Date(parsed.validTo).getTime()).toBe(notAfter.getTime());
  });

  test('the emitted key is the private half of the certificate public key', () => {
    const cert = makeCert();
    expect(cert.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(
      new X509Certificate(cert.certPem).checkPrivateKey(
        // Round-trips through PEM, i.e. exactly what serve() hands to Bun.serve.
        require('node:crypto').createPrivateKey(cert.keyPem),
      ),
    ).toBe(true);
  });

  test('two runs never share a serial or a fingerprint', () => {
    const a = makeCert();
    const b = makeCert();
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
    expect(new X509Certificate(a.certPem).serialNumber).not.toBe(
      new X509Certificate(b.certPem).serialNumber,
    );
  });

  test('a long serial with the high bit set stays a positive INTEGER', () => {
    const cert = generateSelfSignedCert({
      commonName: 'x',
      altNames: [],
      notBefore: new Date(Date.now() - 1000),
      notAfter: new Date(Date.now() + oneYear),
      serialNumber: Uint8Array.from([0xff, 0x01, 0x02, 0x03]),
      keyPair: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    });
    // Node prints the serial as uppercase hex; the DER pad must not show up.
    expect(new X509Certificate(cert.certPem).serialNumber).toBe('FF010203');
  });
});
