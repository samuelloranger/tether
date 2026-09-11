import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { controlSocketIsLive, hardenControlSocket, prepareControlSocket } from './socket';

describe('prepareControlSocket', () => {
  test('creates the socket dir 0700 and removes a stale socket file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    const sock = path.join(dir, 'nested', 'control.sock');
    await prepareControlSocket(sock); // dir must be created first
    writeFileSync(sock, 'stale'); // simulate a crashed daemon's leftover socket
    await prepareControlSocket(sock); // must not throw, must unlink the stale file
    expect(() => statSync(sock)).toThrow();
    expect(statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
  });

  test('refuses to unlink a socket a live daemon is still serving', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    const sock = path.join(dir, 'control.sock');
    const server = Bun.serve({ unix: sock, fetch: () => new Response('ok') });
    try {
      expect(prepareControlSocket(sock)).rejects.toThrow(/already serving/);
      // The point of refusing: the live listener is still reachable afterwards.
      expect(await controlSocketIsLive(sock)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test('hardenControlSocket does not throw when the socket is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    expect(() => hardenControlSocket(path.join(dir, 'missing.sock'))).not.toThrow();
  });
});

describe('controlSocketIsLive', () => {
  test('is false for a missing path and for a regular file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    expect(await controlSocketIsLive(path.join(dir, 'missing.sock'))).toBe(false);
    const notASocket = path.join(dir, 'control.sock');
    writeFileSync(notASocket, 'stale');
    expect(await controlSocketIsLive(notASocket)).toBe(false);
  });
});
