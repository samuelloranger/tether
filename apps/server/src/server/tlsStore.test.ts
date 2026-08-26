import { afterEach, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CERT_VALID_DAYS, ensureTlsMaterial, localAltNames, tlsPaths } from './tlsStore';

const dirs: string[] = [];

function tempDir(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tether-tls-')), 'tls');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('ensureTlsMaterial', () => {
  test('generates a usable certificate on first call', () => {
    const dir = tempDir();
    const material = ensureTlsMaterial(dir);
    expect(material.generated).toBe(true);
    expect(material.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    const cert = new X509Certificate(material.certPem);
    expect(cert.verify(cert.publicKey)).toBe(true);
    // Roughly CERT_VALID_DAYS out, allowing for the one-minute backdate.
    const days = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(CERT_VALID_DAYS - 2);
    expect(days).toBeLessThan(CERT_VALID_DAYS + 1);
  });

  test('is backdated so a slightly slow client clock still accepts it', () => {
    const cert = new X509Certificate(ensureTlsMaterial(tempDir()).certPem);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
  });

  test('NEVER regenerates: a second call returns the same pinned fingerprint', () => {
    const dir = tempDir();
    const first = ensureTlsMaterial(dir);
    const second = ensureTlsMaterial(dir);
    expect(second.generated).toBe(false);
    expect(second.fingerprintSha256).toBe(first.fingerprintSha256);
    expect(second.certPem).toBe(first.certPem);
  });

  test('the private key is owner-read-only and the directory is owner-only', () => {
    const dir = tempDir();
    ensureTlsMaterial(dir);
    const paths = tlsPaths(dir);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The certificate is public by nature — readable is correct.
    expect(statSync(paths.certPath).mode & 0o777).toBe(0o644);
  });

  test('a half-written directory throws instead of minting a new identity', () => {
    const dir = tempDir();
    const original = ensureTlsMaterial(dir);
    rmSync(tlsPaths(dir).keyPath);
    expect(() => ensureTlsMaterial(dir)).toThrow(/Refusing to regenerate/);
    // The surviving certificate is untouched — restoring the key recovers the
    // original identity rather than forcing every client to re-pair.
    writeFileSync(tlsPaths(dir).keyPath, original.keyPem, { mode: 0o600 });
    expect(ensureTlsMaterial(dir).fingerprintSha256).toBe(original.fingerprintSha256);
  });

  test('a key with no certificate throws too', () => {
    const dir = tempDir();
    const material = ensureTlsMaterial(dir);
    rmSync(tlsPaths(dir).certPath);
    writeFileSync(tlsPaths(dir).keyPath, material.keyPem);
    expect(() => ensureTlsMaterial(dir)).toThrow(/Refusing to regenerate/);
  });
});

describe('localAltNames', () => {
  test('always covers loopback', () => {
    const names = localAltNames({});
    expect(names).toContain('localhost');
    expect(names).toContain('127.0.0.1');
    expect(names).toContain('::1');
  });

  test('has no duplicates and no link-local IPv6', () => {
    const names = localAltNames({});
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => n.startsWith('fe80:'))).toBe(false);
  });

  test('picks up operator-supplied extra names', () => {
    const names = localAltNames({ TETHER_TLS_EXTRA_NAMES: 'tether.ts.net, 100.64.0.1' });
    expect(names).toContain('tether.ts.net');
    expect(names).toContain('100.64.0.1');
  });

  test('the generated certificate actually carries them', () => {
    const material = ensureTlsMaterial(tempDir());
    const san = new X509Certificate(material.certPem).subjectAltName ?? '';
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP Address:127.0.0.1');
  });
});
