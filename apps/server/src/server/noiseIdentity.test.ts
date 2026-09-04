import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadOrCreateServerKeypair, serverFingerprint } from './noiseIdentity';

describe('noise identity', () => {
  test('creates a 32-byte keypair on first call, persists on the second', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tether-noise-')), 'noise');
    const first = loadOrCreateServerKeypair(dir);
    expect(first.pub.length).toBe(32);
    expect(first.priv.length).toBe(32);

    const second = loadOrCreateServerKeypair(dir);
    expect([...second.pub]).toEqual([...first.pub]);
    expect([...second.priv]).toEqual([...first.priv]);
  });

  test('private key file is owner-only (0600)', () => {
    if (process.platform === 'win32') return;
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tether-noise-')), 'noise');
    loadOrCreateServerKeypair(dir);
    const mode = statSync(path.join(dir, 'server.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('fingerprint is stable 64-hex', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tether-noise-')), 'noise');
    const { pub } = loadOrCreateServerKeypair(dir);
    const fp = serverFingerprint(pub);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(serverFingerprint(pub)).toBe(fp);
  });
});
