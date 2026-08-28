// Windows equivalent of the 0o700 / 0o600 modes the state files are created
// with everywhere else.
//
// Node maps `chmod` on Windows onto the read-only attribute: a 0o600 request
// reads back as 0o666 and grants nothing. So every `mkdirSync(dir, {mode})` and
// `chmodSync(path, 0o600)` in this codebase is a silent no-op there, and the
// TLS private key, the SQLite DB holding the argon2 password hash, the holder
// IPC sockets and the present-control token rest entirely on whatever ACL they
// inherit from the user profile.
//
// That inherited ACL is usually adequate (a standard user cannot read another
// user's profile), but "usually" is not what 0o700 promises, and a profile
// whose permissions were loosened — a shared or redirected profile, a folder
// restored from a backup, a directory created before the profile was locked
// down — silently exposes all of it.
//
// The faithful stand-in is an explicit ACL: drop inherited entries and grant
// the current user alone. Administrators and SYSTEM lose their INHERITED
// entries with everyone else, which mirrors POSIX — root can still read a 0700
// file by taking ownership, and so can an administrator here.
//
// What `/inheritance:r` does not touch is an entry that was already EXPLICIT on
// the path, and some hosts ship one: a GitHub Actions runner's temp directory
// hands its children explicit SYSTEM and Administrators ACEs, which survive
// this call. That is not a weakening — they are the root-equivalent principals
// POSIX concedes to as well — but it does mean this grants owner-only access
// rather than guaranteeing an owner-only ACL, and the distinction is worth
// keeping straight. An ordinary second user is never among them; winAcl.test.ts
// asserts exactly that, by SID.
//
// Applied through `icacls` rather than a native API: setting a DACL from
// scratch needs SetNamedSecurityInfo plus a hand-built ACL, which is a large
// amount of FFI for something the in-box tool does correctly in one call.
import { spawnSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Opt-out for the test suite. Every test process creates its own temp state
 * directories, so without this the suite would pay an `icacls` spawn per
 * directory per worker for an ACL nothing asserts on.
 */
const SKIP = process.env.TETHER_SKIP_WINDOWS_ACL === '1';

export type AclResult = 'applied' | 'failed' | 'skipped';

/**
 * The account to grant. `USERDOMAIN\USERNAME` is what `icacls` wants for a
 * domain or Microsoft account; a plain local account has USERDOMAIN set to the
 * machine name, which also resolves. Falls back to the bare username.
 *
 * Deliberately read from the environment rather than spawning `whoami`: this
 * runs on the boot path, and the two variables are set by the session the
 * daemon was launched from in every case that matters.
 */
export function currentUserPrincipal(env: NodeJS.ProcessEnv = process.env): string | null {
  const user = env.USERNAME;
  if (!user) return null;
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

/**
 * The `icacls` arguments that restrict `target` to its owner.
 *
 * `/inheritance:r` converts inherited entries into nothing rather than copying
 * them (`:d` would preserve exactly what we are trying to drop), and `/grant:r`
 * replaces any existing entry for the principal instead of adding a second one,
 * which keeps the call idempotent. `(OI)(CI)` makes the grant inheritable so
 * files created inside a directory later — a rotated log, a new holder socket —
 * are covered without a second call; it is meaningless on a file and omitted.
 *
 * Split out from the spawn so the argument shape is testable off Windows.
 */
export function icaclsArgs(target: string, principal: string, isDir: boolean): string[] {
  const rights = isDir ? '(OI)(CI)F' : 'F';
  return [target, '/inheritance:r', '/grant:r', `${principal}:${rights}`, '/Q'];
}

/**
 * Restrict `target` to the current user. Best-effort by design: a failure means
 * the path keeps its inherited ACL, which is the behaviour that shipped before
 * this existed, and is never worth failing a boot over.
 *
 * A no-op off Windows, where the mode bits passed at creation already did this.
 */
export function secureWindowsPath(target: string, isDir: boolean): AclResult {
  if (!IS_WINDOWS || SKIP) return 'skipped';
  const principal = currentUserPrincipal();
  if (!principal) return 'failed';
  try {
    const proc = spawnSync('icacls.exe', icaclsArgs(target, principal, isDir), {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return proc.status === 0 ? 'applied' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Secure a directory only if this call is the one that created it.
 *
 * `mkdirSync(..., {recursive: true})` returns the first path it had to create
 * and `undefined` when everything already existed, which is exactly the signal
 * needed: re-running `icacls` on every boot costs a process spawn to confirm an
 * ACL that has not changed since the directory appeared.
 *
 * Callers that must tighten a directory created by an older version should call
 * `secureWindowsPath` directly instead.
 */
export function secureCreatedDir(created: string | undefined): AclResult {
  if (created === undefined) return 'skipped';
  return secureWindowsPath(created, true);
}
