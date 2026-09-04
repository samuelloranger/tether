import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentUserPrincipal, icaclsArgs, secureCreatedDir, secureWindowsPath } from './winAcl';

const IS_WINDOWS = process.platform === 'win32';

/**
 * How long a PowerShell probe may take before it counts as a failure.
 *
 * Only ever hit on a runner that is thrashing; a warm powershell.exe answers in
 * well under a second. Large rather than tight because the cost of overshooting
 * is a slow test and the cost of undershooting is a red release gate.
 */
const PS_TIMEOUT_MS = 30_000;

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

/**
 * The SID of every principal granted access to `target`.
 *
 * Read through Get-Acl and translated to SIDs rather than scraped out of
 * `icacls` text. Account *names* are neither stable nor parseable: icacls
 * prints a bare SID when a name does not resolve, localises the well-known
 * ones ("AUTORITE NT\Système" here, "NT AUTHORITY\SYSTEM" on an English
 * install), and lays them out positionally. A SID is the identity itself.
 */
function grantedSids(target: string): string[] {
  const shown = spawnSync('icacls.exe', [target], { encoding: 'utf8', windowsHide: true });
  // `<path> ACCOUNT:(FLAGS)` on the first line, then `ACCOUNT:(FLAGS)` indented.
  // The trailing summary line is localised ("1 fichiers correctement traités")
  // and carries no ':(', so it drops out here rather than needing a match.
  const names = (shown.stdout ?? '')
    .split('\n')
    .map((line) => line.replace(target, '').trim())
    .filter((line) => line.includes(':('))
    .map((line) => line.slice(0, line.indexOf(':(')).trim())
    .filter(Boolean);
  return names.length === 0 ? [] : translateToSids(names);
}

/**
 * Account names to SIDs.
 *
 * Deliberately NOT `Get-Acl`: that cmdlet lives in Microsoft.PowerShell.Security,
 * which fails to load on this development machine ("le module n'a pas pu être
 * chargé"), so it returned an empty access list and made a perfectly correct ACL
 * look like an empty one. `icacls` is the tool the implementation itself uses and
 * is always present; `NTAccount.Translate` is a plain .NET type and needs no
 * module.
 *
 * A name that will not translate is passed through unchanged, which is right in
 * the one case it happens: icacls prints a bare SID when it cannot resolve the
 * account, and that string is already the answer.
 */
function translateToSids(names: string[]): string[] {
  const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `foreach ($n in @(${list})) { try { ` +
        '[System.Security.Principal.NTAccount]::new($n).Translate(' +
        '[System.Security.Principal.SecurityIdentifier]).Value } catch { $n } }',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: PS_TIMEOUT_MS },
  );
  return (ps.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Principals whose access is not a weakening, so the assertions below tolerate
 * them if the host had already granted them explicitly.
 *
 * `/inheritance:r` removes INHERITED entries; an entry that was already
 * explicit on the path survives it. These are the ones that legitimately can
 * be, and they are the Windows equivalent of root — POSIX makes exactly the
 * same concession, since root reads a 0700 file regardless. What must never
 * appear is an ordinary second user.
 */
const PRIVILEGED_SIDS = new Set([
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-32-544', // BUILTIN\Administrators
  'S-1-3-0', // CREATOR OWNER
  'S-1-3-4', // OWNER RIGHTS
]);

/**
 * Our own SID, the one identity that must be granted.
 *
 * Asked of .NET rather than of `whoami /user`, which looks like the obvious
 * tool and is a trap: Git for Windows ships a POSIX `whoami` that wins on PATH
 * inside a Git Bash environment, rejects `/user`, and exits 1 with empty
 * stdout — so the SID silently came back null and every assertion below
 * collapsed into "expected not null".
 */
let cachedUserSid: string | null | undefined;

function currentUserSid(): string | null {
  // The SID cannot change inside one test process, and every assertion asks for
  // it — so pay for PowerShell once rather than per check.
  if (cachedUserSid !== undefined) return cachedUserSid;
  cachedUserSid = readUserSid() ?? readUserSid();
  return cachedUserSid;
}

/**
 * One attempt at the SID.
 *
 * The timeout is explicit and generous on purpose. A cold `powershell.exe` on a
 * loaded CI runner takes seconds to start, and when the budget ran out
 * spawnSync returned empty stdout — indistinguishable from "no SID" — so the
 * assertion failed as a bare `Received: null` and this suite flaked on Windows
 * about half the time, blocking the release gate for reasons that had nothing
 * to do with the release. `currentUserSid` retries once on top of this: a
 * runner slow enough to miss the budget once is not necessarily slow twice.
 */
function readUserSid(): string | null {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: PS_TIMEOUT_MS },
  );
  const sid = (ps.stdout ?? '').trim();
  return /^S-1-[\d-]+$/.test(sid) ? sid : null;
}

/**
 * The security property, asserted so a failure names the offender.
 *
 * bun:test has no assertion message, and "expected 1, received 3" told us
 * nothing about WHICH principals had access — which is the only part that
 * decides whether a difference is benign or a hole.
 */
function expectOwnerOnly(target: string, label: string): void {
  const mine = currentUserSid();
  expect(mine).not.toBeNull();
  const sids = grantedSids(target);
  const strangers = sids.filter((sid) => sid !== mine && !PRIVILEGED_SIDS.has(sid));
  if (strangers.length > 0) {
    throw new Error(
      `${label}: unprivileged principals still have access: ${strangers.join(', ')}\n` +
        `(all granted: ${sids.join(', ') || 'none'}; ours: ${mine})`,
    );
  }
  expect(sids).toContain(mine as string);
}

test.skipIf(!IS_WINDOWS)(
  'applies a real owner-only ACL to a directory',
  () => {
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

      // We are granted, and nobody unprivileged is. See expectOwnerOnly for why
      // that is the property rather than "exactly one entry".
      expect(currentUserPrincipal()).not.toBeNull();
      expectOwnerOnly(dir, 'directory');

      // And the grant is inheritable, which is what lets the files created inside
      // HOLDERS_DIR skip an icacls spawn each.
      expect(acl).toMatch(/\(OI\)\(CI\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Spawns a child (secureInChild) plus several icacls.exe reads; slow enough on
    // a contended Windows CI runner to exceed bun's 5000ms default.
  },
  20_000,
);

test.skipIf(!IS_WINDOWS)(
  'a directory ACL is inherited by files created inside it',
  () => {
    // The claim ptyHolder.ts and holder.ts rely on to avoid two icacls spawns per
    // session start. Asserted rather than assumed, because if inheritance did not
    // in fact reach new files the holder socket and pid file would be silently
    // unprotected.
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-acl-inherit-'));
    try {
      expect(secureInChild(dir, true)).toBe('applied');
      const child = path.join(dir, 'session.sock.pid');
      Bun.write(child, '1234');

      // The inherited grant reached the new file, and brought nothing else with it.
      expectOwnerOnly(child, 'inherited file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(!IS_WINDOWS)(
  'reports failure instead of throwing on a path that does not exist',
  () => {
    // Best-effort by design: the wiring sites call this on the boot path and must
    // never have a boot fail over an ACL that could not be set.
    const missing = path.join(tmpdir(), `tether-acl-missing-${process.pid}`, 'nope');
    expect(secureInChild(missing, false)).toBe('failed');
  },
);
