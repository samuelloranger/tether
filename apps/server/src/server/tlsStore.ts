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
import { secureCreatedDir, secureWindowsPath } from './winAcl';
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

  const createdDir = mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Windows counterpart of the 0o700: neither of the two lines above grants or
  // denies anything there. See winAcl.ts.
  secureCreatedDir(createdDir);

  writeFileSync(paths.keyPath, cert.keyPem, { mode: 0o600 });
  // writeFileSync's mode is masked by umask, and does nothing at all if the file
  // already existed — chmod is the only way to be sure about the private key.
  chmodSync(paths.keyPath, 0o600);
  // The private key gets an ACL of its own rather than relying on the one it
  // inherits from `dir`, and it is the only file here that does. secureCreatedDir
  // fires solely on the boot that created the directory, so a TLS dir laid down
  // by a tether older than winAcl.ts keeps its inherited profile ACL forever —
  // and a key that outlives its directory's protection is the one failure in
  // this module worth spending an unconditional `icacls` spawn to prevent. This
  // path runs once in the lifetime of an install (generation is once-only, by
  // design), so there is no hot path to protect here.
  secureWindowsPath(paths.keyPath, false);

  writeFileSync(paths.certPath, cert.certPem, { mode: 0o644 });
  chmodSync(paths.certPath, 0o644);
  // Deliberately NO ACL call for the certificate.
  //
  // 0o644 is a statement that the cert is public material — it is the very thing
  // clients pin and the server hands to anyone who completes a TLS handshake. On
  // POSIX that 0o644 is already unreachable by another account, because the 0o700
  // directory above blocks the traversal; the mode only says "nothing secret
  // here". Windows lands in exactly the same place: the cert inherits the
  // directory's owner-only grant, so the two platforms agree.
  //
  // Tightening it explicitly would therefore buy nothing, and loosening it —
  // granting Users read — would hand out access POSIX never grants either. The
  // faithful translation of "0o644 inside 0o700" is to leave it alone, and skip
  // the process spawn.

  return readMaterial(paths, true);
}
