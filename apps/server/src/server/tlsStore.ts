// On-disk home for the server's self-signed TLS material.
//
// The certificate fingerprint is what clients pin, so the one rule this module
// enforces above all others: **never regenerate a certificate that already
// exists**. Silently rotating it would lock out every paired client with no
// error message they could act on. Generation happens exactly once, on the first
// boot that finds the directory empty.

import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './paths';
import { certFingerprint, generateSelfSignedCert, normalizeAltNames } from './x509';

// Sits beside config/tether.db, so a dev run (repo-local DB) never reads or
// writes the installed daemon's certificate. Same reasoning as DB_PATH.
export const TLS_DIR = path.join(CONFIG_DIR, 'tls');

export const CERT_VALID_DAYS = 3650;

export type TlsPaths = { dir: string; certPath: string; keyPath: string };

export function tlsPaths(dir: string = TLS_DIR): TlsPaths {
  return { dir, certPath: path.join(dir, 'cert.pem'), keyPath: path.join(dir, 'key.pem') };
}

export type TlsMaterial = {
  certPem: string;
  keyPem: string;
  /** Lowercase hex SHA-256 of the certificate DER — the value clients pin. */
  fingerprintSha256: string;
  /** True only on the boot that created it. */
  generated: boolean;
  notAfter: string;
};

/**
 * Every name this host might reasonably be reached by. Self-signed certificates
 * are pinned by fingerprint rather than validated by name, but a SAN that
 * matches keeps stock TLS stacks (curl, browsers, Tauri's reqwest) from failing
 * hostname verification on top of the trust failure they already report.
 */
export function localAltNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = ['localhost', '127.0.0.1', '::1'];
  const host = hostname();
  if (host) {
    names.push(host);
    // Avahi/Bonjour reach the same box as <host>.local.
    if (!host.includes('.')) names.push(`${host}.local`);
  }
  if (env.TETHER_TLS_EXTRA_NAMES) names.push(...env.TETHER_TLS_EXTRA_NAMES.split(','));
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      // Link-local IPv6 carries a zone index that has no SAN representation.
      if (addr.address.startsWith('fe80:')) continue;
      names.push(addr.address);
    }
  }
  return normalizeAltNames(names);
}

function readMaterial(paths: TlsPaths, generated: boolean): TlsMaterial {
  const certPem = readFileSync(paths.certPath, 'utf8');
  const keyPem = readFileSync(paths.keyPath, 'utf8');
  const cert = new X509Certificate(certPem);
  return {
    certPem,
    keyPem,
    fingerprintSha256: certFingerprint(new Uint8Array(cert.raw)),
    generated,
    notAfter: cert.validTo,
  };
}

/**
 * Load the certificate, generating one only if neither file is present.
 *
 * A half-populated directory throws rather than regenerating: it is either a
 * botched manual edit or a partial write, and in both cases quietly minting a
 * new identity is the worst available outcome.
 */
export function ensureTlsMaterial(dir: string = TLS_DIR): TlsMaterial {
  const paths = tlsPaths(dir);
  const hasCert = existsSync(paths.certPath);
  const hasKey = existsSync(paths.keyPath);

  if (hasCert && hasKey) return readMaterial(paths, false);
  if (hasCert !== hasKey) {
    throw new Error(
      `TLS material in ${dir} is incomplete (cert: ${hasCert}, key: ${hasKey}). ` +
        'Refusing to regenerate, because the fingerprint is pinned by paired clients. ' +
        `Restore the missing file, or delete ${dir} to re-pair every client from scratch.`,
    );
  }

  const now = new Date();
  const cert = generateSelfSignedCert({
    commonName: hostname() || 'tether',
    altNames: localAltNames(),
    // Backdated a minute so a client whose clock runs slightly behind ours does
    // not reject a certificate that is "not yet valid".
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + CERT_VALID_DAYS * 86_400_000),
  });

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(paths.keyPath, cert.keyPem, { mode: 0o600 });
  // writeFileSync's mode is masked by umask, and does nothing at all if the file
  // already existed — chmod is the only way to be sure about the private key.
  chmodSync(paths.keyPath, 0o600);
  writeFileSync(paths.certPath, cert.certPem, { mode: 0o644 });
  chmodSync(paths.certPath, 0o644);

  return readMaterial(paths, true);
}
