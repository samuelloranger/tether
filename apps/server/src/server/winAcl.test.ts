import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentUserPrincipal, icaclsArgs, secureCreatedDir, secureWindowsPath } from './winAcl';

const IS_WINDOWS = process.platform === 'win32';

// System32, for calling whoami by absolute path — see readUserSid.
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

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

// SDDL parsing + canonicalisation. Pure, so it runs on every platform — which
// is the point: the failure it guards against showed up only on the GitHub
// runner (which logs in AS the built-in Administrator, RID 500, so `icacls
// /save` writes our own grant as the `LA` alias) and a Windows-only test could
// not have caught it before a red CI run.

test('machineSidPrefix strips the RID off an account SID', () => {
  expect(machineSidPrefix('S-1-5-21-1-2-3-500')).toBe('S-1-5-21-1-2-3');
  expect(machineSidPrefix('S-1-5-18')).toBeNull(); // not an S-1-5-21 account SID
  expect(machineSidPrefix(null)).toBeNull();
});

test('canonicalizeSddlPrincipal maps aliases to SIDs and leaves raw SIDs alone', () => {
  const prefix = 'S-1-5-21-1-2-3';
  expect(canonicalizeSddlPrincipal('SY', prefix)).toBe('S-1-5-18');
  expect(canonicalizeSddlPrincipal('BA', prefix)).toBe('S-1-5-32-544');
  expect(canonicalizeSddlPrincipal('LA', prefix)).toBe('S-1-5-21-1-2-3-500');
  expect(canonicalizeSddlPrincipal('S-1-5-21-1-2-3-1000', prefix)).toBe('S-1-5-21-1-2-3-1000');
  expect(canonicalizeSddlPrincipal('WD', prefix)).toBe('WD'); // unknown alias kept, reads as a stranger
});

test('the owner-only check tolerates the GitHub-runner ACL where we ARE the built-in Administrator', () => {
  // Exact shape from the runner: SYSTEM + Administrators as raw SIDs, and our
  // own grant — the built-in Administrator — as the LA alias.
  const mine = 'S-1-5-21-1456194669-2875347699-3862154473-500';
  const prefix = machineSidPrefix(mine);
  const sddl = 'D:PAI(A;OICIID;FA;;;S-1-5-18)(A;OICIID;FA;;;S-1-5-32-544)(A;OICI;FA;;;LA)';
  const sids = sidsFromSddl(sddl, prefix);
  const privileged = new Set([
    ...FIXED_PRIVILEGED_SIDS,
    `${prefix}-500`,
    `${prefix}-512`,
    `${prefix}-519`,
  ]);
  const strangers = sids.filter((sid) => sid !== mine && !privileged.has(sid));
  expect(strangers).toEqual([]);
  expect(sids).toContain(mine); // LA canonicalised to our SID
});

test('the owner-only check still flags an ordinary second user', () => {
  const mine = 'S-1-5-21-1-2-3-1000';
  const prefix = machineSidPrefix(mine);
  const sddl = `D:(A;;FA;;;${mine})(A;;FA;;;S-1-5-21-1-2-3-1001)`;
  const sids = sidsFromSddl(sddl, prefix);
  const privileged = new Set([
    ...FIXED_PRIVILEGED_SIDS,
    `${prefix}-500`,
    `${prefix}-512`,
    `${prefix}-519`,
  ]);
  const strangers = sids.filter((sid) => sid !== mine && !privileged.has(sid));
  expect(strangers).toEqual(['S-1-5-21-1-2-3-1001']);
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
 * The SID of every principal granted access to `target`, read from the object's
 * own SDDL via `icacls <target> /save`.
 *
 * This deliberately replaces an older `icacls`-text-plus-`NTAccount.Translate`
 * path. Parsing icacls' human output means dealing with account *names*, which
 * are localised ("AUTORITE NT\Système" vs "NT AUTHORITY\SYSTEM") and positional,
 * so the old code shelled out to powershell.exe to translate them back to SIDs —
 * and a cold powershell.exe under CI load was THE server-windows flake: it
 * returned empty and a perfectly correct ACL read as an empty one. `/save`
 * writes the raw SDDL (works for a file or a directory), whose ACEs already
 * carry SIDs; no PowerShell, no cold start.
 */
function grantedSids(target: string, machinePrefix: string | null): string[] {
  const out = path.join(tmpdir(), `tether-acl-sddl-${process.pid}-${aclNonce()}.txt`);
  try {
    const saved = spawnSync('icacls.exe', [target, '/save', out], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (saved.status !== 0) return [];
    let sddl: string;
    try {
      sddl = readFileSync(out, 'utf16le');
    } catch {
      return [];
    }
    return sidsFromSddl(sddl, machinePrefix);
  } finally {
    rmSync(out, { force: true });
  }
}

let aclNonceCounter = 0;
const aclNonce = () => `${Date.now()}-${aclNonceCounter++}`;

/**
 * Every ACE's principal as a SID, from an SDDL string. An ACE is
 * `(type;flags;rights;object;inherit;principal)`; the principal is the 6th
 * field. `icacls /save` writes it inconsistently — an ordinary account as a raw
 * `S-1-...` SID, a well-known one as a two-letter alias, and even the same
 * well-known principal one way here and the other on another host (the GitHub
 * runner prints SYSTEM/Administrators as raw SIDs but the built-in
 * Administrator as `LA`). `canonicalizeSddlPrincipal` maps every alias back to
 * a SID so a caller compares like with like.
 */
function sidsFromSddl(sddl: string, machinePrefix: string | null): string[] {
  const sids: string[] = [];
  for (const ace of sddl.matchAll(/\(([^)]*)\)/g)) {
    const principal = ace[1].split(';')[5]?.trim();
    if (principal) sids.push(canonicalizeSddlPrincipal(principal, machinePrefix));
  }
  return sids;
}

/**
 * An SDDL principal to a SID. A raw SID passes through. Fixed aliases map to
 * their constant SIDs; the machine/domain-relative ones (LA = the built-in
 * Administrator, RID 500 — which is the account the GitHub runner itself logs
 * in as, so our OWN grant comes back as `LA`) only become a SID once combined
 * with a machine SID, which we take from our own SID's prefix. An unknown alias
 * is kept verbatim so it still reads as a stranger rather than silently
 * vanishing.
 */
function canonicalizeSddlPrincipal(principal: string, machinePrefix: string | null): string {
  const fixed: Record<string, string> = {
    SY: 'S-1-5-18', // NT AUTHORITY\SYSTEM
    BA: 'S-1-5-32-544', // BUILTIN\Administrators
    CO: 'S-1-3-0', // CREATOR OWNER
    OW: 'S-1-3-4', // OWNER RIGHTS
  };
  if (fixed[principal]) return fixed[principal];
  if (machinePrefix) {
    const relative: Record<string, string> = {
      LA: `${machinePrefix}-500`, // built-in Administrator account
      DA: `${machinePrefix}-512`, // Domain Admins
      EA: `${machinePrefix}-519`, // Enterprise Admins
    };
    if (relative[principal]) return relative[principal];
  }
  return principal;
}

/** The machine/domain SID that an `S-1-5-21-…-<RID>` account SID hangs off. */
function machineSidPrefix(sid: string | null): string | null {
  const m = sid?.match(/^(S-1-5-21-\d+-\d+-\d+)-\d+$/);
  return m ? m[1] : null;
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
 *
 * The machine-relative admins (the built-in Administrator, Domain/Enterprise
 * Admins) are added per-check in `expectOwnerOnly`, since their SIDs depend on
 * the machine prefix.
 */
const FIXED_PRIVILEGED_SIDS = [
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-32-544', // BUILTIN\Administrators
  'S-1-3-0', // CREATOR OWNER
  'S-1-3-4', // OWNER RIGHTS
];

/**
 * Our own SID, the one identity that must be granted.
 */
let cachedUserSid: string | null | undefined;

function currentUserSid(): string | null {
  // The SID cannot change inside one test process, and every assertion asks for
  // it — so read it once and cache.
  if (cachedUserSid !== undefined) return cachedUserSid;
  cachedUserSid = readUserSid();
  return cachedUserSid;
}

/**
 * Our own SID, from the header-less `NAME SID` line of `whoami /user /nh`.
 *
 * Called by absolute path out of System32, never bare `whoami`: Git for Windows
 * ships a POSIX `whoami.exe` that wins on PATH inside a Git Bash environment,
 * rejects `/user`, and exits 1 empty — which silently returned null and
 * collapsed every assertion into "expected not null". The System32 tool answers
 * in milliseconds with no cold start, which is the point of not asking
 * powershell.exe: on a loaded CI runner its cold start was the flake this whole
 * change removes. (`/user /fmt:list` is NOT valid — whoami rejects it; `/nh`
 * drops the table header instead.)
 */
function readUserSid(): string | null {
  const r = spawnSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = (r.stdout ?? '').match(/S-1-[\d-]+/);
  return sid ? sid[0] : null;
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
  const prefix = machineSidPrefix(mine);
  // The privileged set includes the machine-relative admins, whose SIDs only
  // exist once combined with this machine's prefix. On the GitHub runner our
  // OWN account IS the built-in Administrator (RID 500), so `mine` is one of
  // these too — harmless, the `sid !== mine` guard below covers it.
  const privileged = new Set([
    ...FIXED_PRIVILEGED_SIDS,
    ...(prefix ? [`${prefix}-500`, `${prefix}-512`, `${prefix}-519`] : []),
  ]);
  const sids = grantedSids(target, prefix);
  const strangers = sids.filter((sid) => sid !== mine && !privileged.has(sid));
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
