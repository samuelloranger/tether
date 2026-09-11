// Run: bun run src/pty.shell.test.ts
// Pure-function test only — does not spawn a PTY.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { shellInvocation } from './pty';
import { describeShellSupport } from './ptyShell';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

// bash: loads the tether rcfile (fish-like prompt + OSC 7), no env changes needed.
{
  const inv = shellInvocation('bash');
  eq(inv.args[0], 'bash', 'bash: first arg is the shell');
  eq(inv.args.includes('--rcfile'), true, 'bash: passes --rcfile');
  eq(inv.args[inv.args.length - 1], '-i', 'bash: interactive flag last');
  eq(inv.env, undefined, 'bash: no env override needed');
}
{
  const inv = shellInvocation('/usr/bin/bash');
  eq(
    inv.args[0],
    '/usr/bin/bash',
    'bash: dispatch matches on basename, but argv[0] keeps the resolved path (daemon PATH may not include it)',
  );
}

// zsh: ZDOTDIR redirect to our injected .zshrc/.zshenv (sources the user's
// real ~/.zshrc and ~/.zshenv, then hooks OSC 7 via precmd_functions —
// invisible, no prompt replacement since zsh users already have their own).
{
  const inv = shellInvocation('zsh');
  eq(inv.args, ['zsh', '-i'], 'zsh: plain interactive invocation, no --rcfile equivalent');
  eq(typeof inv.env?.ZDOTDIR, 'string', 'zsh: ZDOTDIR env override is set');
  eq(inv.env!.ZDOTDIR!.length > 0, true, 'zsh: ZDOTDIR is non-empty');
}
{
  // ZDOTDIR redirects ALL of zsh's startup files, not just .zshrc — .zshenv
  // is read even for non-interactive shells and is the canonical place users
  // put PATH/SDK-manager/Nix env setup. Without an injected .zshenv sourcing
  // the real one, that setup silently vanishes (zsh does not fall back to
  // ~/.zshenv once ZDOTDIR is set).
  const inv = shellInvocation('zsh');
  const zshenvPath = path.join(inv.env!.ZDOTDIR!, '.zshenv');
  eq(existsSync(zshenvPath), true, 'zsh: an injected .zshenv exists alongside .zshrc');
  eq(
    readFileSync(zshenvPath, 'utf8').includes('~/.zshenv'),
    true,
    'zsh: injected .zshenv sources the real ~/.zshenv',
  );
}

// fish: --init-command defines the OSC 7 hook before fish's own config.fish
// runs — no env-var redirection at all, so unrelated XDG-aware tools inside
// the session are unaffected (a real risk with a naive XDG_CONFIG_HOME trick).
{
  const inv = shellInvocation('fish');
  eq(inv.args[0], 'fish', 'fish: first arg is the shell');
  eq(inv.args.includes('--init-command'), true, 'fish: passes --init-command');
  eq(inv.args[inv.args.length - 1], '-i', 'fish: interactive flag last');
  eq(inv.env, undefined, 'fish: no env override (unlike zsh)');
}
{
  const inv = shellInvocation('/usr/bin/fish');
  eq(
    inv.args[0],
    '/usr/bin/fish',
    'fish: dispatch matches on basename, but argv[0] keeps the resolved path',
  );
}

// Anything else (sh, tcsh, ksh, a custom command…): run as-is, matching the
// pre-existing fallback behavior — no shell integration attempted.
{
  const inv = shellInvocation('dash');
  const expected = ['dash', '-i'];
  eq(inv.args, expected, 'unknown shell: passthrough, no hook');
  eq(inv.env, undefined, 'unknown shell: no env override');
}

// bash/zsh/fish are the hooked three. The pairing with shellInvocation is
// asserted too — 'full' is a claim about a hook that has to
// really be injected, and that is the half that would silently rot if one side
// gained a shell the other did not.
for (const cmd of ['bash', '/usr/bin/bash', 'zsh', 'fish', '/opt/homebrew/bin/fish']) {
  eq(describeShellSupport(cmd).integration, 'full', `${cmd}: full integration on POSIX`);
  // A hooked invocation carries something the bare one does not — extra args
  // beyond [command, '-i'], OR an env override.
  // zsh is the reason for the second half: it has no --rcfile equivalent, so its
  // hook rides in entirely through ZDOTDIR and its argv is exactly the bare
  // [command, '-i']. Counting args alone called that "not injected".

  const invocation = shellInvocation(cmd);
  const baseline = 2;
  const injected = invocation.args.length > baseline || invocation.env !== undefined;
  eq(injected, true, `${cmd}: shellInvocation really does inject something`);
}
for (const cmd of ['sh', 'dash', '/bin/tcsh', 'nu']) {
  eq(describeShellSupport(cmd).integration, 'none', `${cmd}: no hook, but not broken`);
}
eq(
  describeShellSupport('bash.exe').integration,
  'none',
  'a .exe on POSIX keeps its extension and matches nothing — no accidental "full"',
);

console.log(`\n  ${pass} assertions passed\n`);
