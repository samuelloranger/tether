import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hardenControlSocket, prepareControlSocket } from './controlSocket';

describe('prepareControlSocket', () => {
  test('creates the socket dir 0700 and removes a stale socket file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    const sock = path.join(dir, 'nested', 'control.sock');
    prepareControlSocket(sock); // dir must be created first
    writeFileSync(sock, 'stale'); // simulate a crashed daemon's leftover socket
    prepareControlSocket(sock); // must not throw, must unlink the stale file
    expect(() => statSync(sock)).toThrow();
    expect(statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
  });

  test('hardenControlSocket does not throw when the socket is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    expect(() => hardenControlSocket(path.join(dir, 'missing.sock'))).not.toThrow();
  });
});
