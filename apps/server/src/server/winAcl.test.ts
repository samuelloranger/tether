import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentUserPrincipal, icaclsArgs, secureCreatedDir, secureWindowsPath } from './winAcl';

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Pure argument shaping. Runs on every platform, which is the whole reason
// icaclsArgs and currentUserPrincipal are exported separately from the spawn:
// the command that protects the TLS key should not be reviewable only on the
// one OS where it runs.
// ---------------------------------------------------------------------------

test('currentUserPrincipal qualifies the user with its domain', () => {
  expect(currentUserPrincipal({ USERNAME: 'sam', USERDOMAIN: 'CORP' })).toBe('CORP\\sam');
});

test('currentUserPrincipal falls back to the bare username with no domain', () => {
  expect(currentUserPrincipal({ USERNAME: 'sam' })).toBe('sam');
});

test('currentUserPrincipal returns null rather than guessing', () => {
  // A null principal makes secureWindowsPath report 'failed' instead of running
  // icacls against some default account — granting the WRONG principal would be
  // worse than leaving the inherited ACL alone, because /inheritance:r would
  // have already stripped the owner's own access.
  expect(currentUserPrincipal({})).toBeNull();
  expect(currentUserPrincipal({ USERDOMAIN: 'CORP' })).toBeNull();
});

test('icaclsArgs drops inheritance and replaces rather than adds the grant', () => {
  const args = icaclsArgs('C:\\state', 'CORP\\sam', false);
  expect(args).toEqual(['C:\\state', '/inheritance:r', '/grant:r', 'CORP\\sam:F', '/Q']);
  // ':r' on both flags is the security-relevant half. '/inheritance:d' would
  // COPY the inherited entries down instead of removing them, which is exactly
  // the access being revoked; a bare '/grant' would add a second entry for the
  // principal and stop the call being idempotent across boots.
  expect(args).toContain('/inheritance:r');
  expect(args).not.toContain('/inheritance:d');
});

test('icaclsArgs makes a directory grant inheritable but not a file grant', () => {
  // (OI)(CI) is what lets holder sockets and the TLS key inherit the owner-only
  // DACL without an icacls spawn of their own — see ptyHolder.ts and holder.ts.
  expect(icaclsArgs('C:\\holders', 'CORP\\sam', true)).toContain('CORP\\sam:(OI)(CI)F');
  expect(icaclsArgs('C:\\holders\\a.sock', 'CORP\\sam', false)).toContain('CORP\\sam:F');
});

test('secureCreatedDir does nothing when mkdirSync created nothing', () => {
  // mkdirSync(..., {recursive:true}) returns undefined when the directory was
  // already there. Treating that as "nothing to do" is what keeps every boot
  // after the first from paying a process spawn.
  expect(secureCreatedDir(undefined)).toBe('skipped');
});

test('secureWindowsPath is inert off Windows', () => {
  // The POSIX creation modes already did this job, so the call has to be free of
  // side effects there — every wiring site invokes it unconditionally.
  if (IS_WINDOWS) return;
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-acl-noop-'));
  try {
    expect(secureWindowsPath(dir, true)).toBe('skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end, Windows only.
//
// test-preload.ts sets TETHER_SKIP_WINDOWS_ACL=1 for the whole suite, so
// secureWindowsPath in THIS process returns 'skipped' and can never be observed
// doing its job. Opting back in by mutating process.env here would be wrong on
// two counts: bun runs test files in one process, so the change would leak into
// every other test in the file, and the module reads the variable once at import
// so a later assignment would not be seen anyway.
//
// A child process is the clean answer. It gets the real environment (the flag
// explicitly cleared), imports the real module, and exits — nothing about the
// suite's own environment is touched, and what is exercised is the genuine
// module rather than a re-implementation of it.
// ---------------------------------------------------------------------------

/** Runs secureWindowsPath in a child that has the suite-wide opt-out cleared. */
function secureInChild(target: string, isDir: boolean): string {
  const source = `
    const { secureWindowsPath } = await import(${JSON.stringify(
      Bun.pathToFileURL(path.join(import.meta.dir, 'winAcl.ts')).href,
    )});
    console.log(secureWindowsPath(${JSON.stringify(target)}, ${isDir}));
  `;
  const env = { ...process.env };
  // The point of the child: unset for it alone, leaving the parent's suite-wide
  // opt-out intact.
  delete env.TETHER_SKIP_WINDOWS_ACL;
  const proc = spawnSync(process.execPath, ['-e', source], { env, encoding: 'utf8' });
  return (proc.stdout ?? '').trim();
}

test.skipIf(!IS_WINDOWS)('applies a real owner-only ACL to a directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-acl-e2e-'));
  try {
    expect(secureInChild(dir, true)).toBe('applied');

    const shown = spawnSync('icacls.exe', [dir], { encoding: 'utf8', windowsHide: true });
    expect(shown.status).toBe(0);
    const acl = shown.stdout;

    // Inheritance was dropped: none of the entries icacls prints may be marked
    // (I). A surviving inherited entry is the whole failure mode this guards
    // against — the profile's ACL flowing down into the state directory.
    expect(acl).not.toContain('(I)');

    // Exactly one principal is granted, and it is us. Administrators and SYSTEM
    // lose their inherited entries too, which mirrors POSIX: root can still read
    // a 0700 file, but only by taking ownership first.
    const principal = currentUserPrincipal();
    expect(principal).not.toBeNull();
    const granted = acl
      .split('\n')
      .map((line) => line.replace(dir, '').trim())
      .filter((line) => line.includes(':('))
      .map((line) => line.slice(0, line.indexOf(':(')));
    expect(granted.length).toBeGreaterThan(0);
    for (const account of granted) {
      expect(account.toLowerCase()).toBe((principal as string).toLowerCase());
    }

    // And the grant is inheritable, which is what lets the files created inside
    // HOLDERS_DIR skip an icacls spawn each.
    expect(acl).toMatch(/\(OI\)\(CI\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!IS_WINDOWS)('a directory ACL is inherited by files created inside it', () => {
  // The claim ptyHolder.ts and holder.ts rely on to avoid two icacls spawns per
  // session start. Asserted rather than assumed, because if inheritance did not
  // in fact reach new files the holder socket and pid file would be silently
  // unprotected.
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-acl-inherit-'));
  try {
    expect(secureInChild(dir, true)).toBe('applied');
    const child = path.join(dir, 'session.sock.pid');
    Bun.write(child, '1234');

    const shown = spawnSync('icacls.exe', [child], { encoding: 'utf8', windowsHide: true });
    expect(shown.status).toBe(0);
    const principal = (currentUserPrincipal() as string).toLowerCase();
    const accounts = shown.stdout
      .split('\n')
      .map((line) => line.replace(child, '').trim())
      .filter((line) => line.includes(':('))
      .map((line) => line.slice(0, line.indexOf(':(')).toLowerCase());
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) expect(account).toBe(principal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!IS_WINDOWS)(
  'reports failure instead of throwing on a path that does not exist',
  () => {
    // Best-effort by design: the wiring sites call this on the boot path and must
    // never have a boot fail over an ACL that could not be set.
    const missing = path.join(tmpdir(), `tether-acl-missing-${process.pid}`, 'nope');
    expect(secureInChild(missing, false)).toBe('failed');
  },
);
