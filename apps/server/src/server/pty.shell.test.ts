// Run: bun run src/server/pty.shell.test.ts
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

// PowerShell: -File runs our generated profile the way bash's --rcfile does
// (the user's own profiles still load first — only -NoProfile would skip them),
// and -NoExit keeps the shell interactive once that script returns.
{
  const inv = shellInvocation('pwsh.exe');
  eq(inv.args[0], 'pwsh.exe', 'pwsh: first arg is the shell');
  eq(inv.args.includes('-NoExit'), true, 'pwsh: stays interactive after the profile runs');
  eq(inv.args.includes('-File'), true, 'pwsh: loads the generated tether profile');
  eq(inv.args.includes('-i'), false, 'pwsh: never gets the POSIX -i (it would be read as a file)');
  eq(inv.env, undefined, 'pwsh: no env override needed');
}
{
  // A configured defaultShell may be bare, suffixed, oddly cased, or absolute —
  // NTFS does not care, so neither does the dispatch.
  for (const cmd of ['pwsh', 'PowerShell.exe', 'powershell']) {
    eq(shellInvocation(cmd).args.includes('-File'), true, `${cmd}: recognized as PowerShell`);
  }
  const abs = shellInvocation(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`);
  eq(
    abs.args[0],
    String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
    'pwsh: dispatch matches on basename, argv[0] keeps the absolute path',
  );
  eq(abs.args.includes('-File'), true, 'pwsh: absolute path still gets the profile');
}

// cmd.exe has no rcfile; PROMPT is the only hook, so the OSC 7 escape rides in
// through the environment instead of an argument.
{
  const inv = shellInvocation('cmd.exe');
  eq(inv.args, ['cmd.exe', '/K'], 'cmd: /K keeps it interactive');
  eq(typeof inv.env?.PROMPT, 'string', 'cmd: PROMPT env override carries the hook');
  eq(inv.env!.PROMPT!.includes('$E]7;file://'), true, 'cmd: PROMPT emits an OSC 7 file URI');
  eq(inv.env!.PROMPT!.includes('$P'), true, 'cmd: PROMPT interpolates the cwd');
}

// Anything else (sh, tcsh, ksh, a custom command…): run as-is, matching the
// pre-existing fallback behavior — no shell integration attempted. `-i` is a
// POSIX-shell convention, so on Windows the passthrough omits it: cmd and
// PowerShell both read it as a file argument and exit immediately.
{
  const inv = shellInvocation('dash');
  const expected = process.platform === 'win32' ? ['dash'] : ['dash', '-i'];
  eq(inv.args, expected, 'unknown shell: passthrough, no hook');
  eq(inv.env, undefined, 'unknown shell: no env override');
}

// --- describeShellSupport -----------------------------------------------
//
// session.defaultShell is client-editable through PATCH /api/config, so the
// $SHELL defence in getDefaultWindowsShell() only ever covered the default: a
// user can still type "bash.exe" and get MSYS paths no Windows API resolves.
// The platform is a parameter (same trick as normalizeOsc7Cwd in liveCwd.ts),
// so the Windows rules are asserted here whatever CI is running on.
{
  // Windows: the three shells shellInvocation() actually hooks.
  for (const cmd of ['pwsh', 'pwsh.exe', 'PowerShell.exe', 'powershell', 'cmd', 'cmd.exe']) {
    const s = describeShellSupport(cmd, true);
    eq(s.integration, 'full', `${cmd}: full integration on Windows`);
    eq(s.reason, null, `${cmd}: nothing to warn about`);
  }
  const abs = describeShellSupport(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, true);
  eq(abs.integration, 'full', 'pwsh: an absolute path is classified on its basename');
  eq(abs.shell, 'pwsh', 'pwsh: the normalized name drops the directory and .exe');
}
{
  // Windows: the whole bash/sh family is broken, wherever it was installed.
  // Every one of them emulates POSIX paths; the install directory only decides
  // which name the message blames.
  const git = describeShellSupport(String.raw`C:\Program Files\Git\bin\bash.exe`, true);
  eq(git.integration, 'broken', 'Git for Windows bash: known-broken');
  eq(git.reason!.includes('Git for Windows'), true, 'git bash: the message names the culprit');
  eq(git.reason!.includes('/c/Users/you'), true, 'git bash: the message shows the symptom');
  eq(
    describeShellSupport(String.raw`C:\msys64\usr\bin\bash.exe`, true).reason!.includes('MSYS2'),
    true,
    'msys2 bash: named',
  );
  eq(
    describeShellSupport(String.raw`C:\cygwin64\bin\sh.exe`, true).reason!.includes('Cygwin'),
    true,
    'cygwin sh: named',
  );
  eq(
    describeShellSupport(String.raw`C:\Windows\System32\bash.exe`, true).reason!.includes('WSL'),
    true,
    'wsl bash launcher: named',
  );
  for (const cmd of ['bash', 'bash.exe', 'sh.exe', 'zsh.exe', 'fish.exe', 'dash', 'ksh']) {
    eq(
      describeShellSupport(cmd, true).integration,
      'broken',
      `${cmd}: broken on Windows even with no install path to inspect`,
    );
  }
  eq(
    describeShellSupport('bash.exe', true).reason!.includes(' from '),
    false,
    'bare bash.exe: no flavour is invented when the path says nothing',
  );
}
{
  // Windows: anything else runs fine, it just gets no cwd hook. Not an error.
  const s = describeShellSupport('nu.exe', true);
  eq(s.integration, 'none', 'nu.exe: no integration, not broken');
  eq(typeof s.reason, 'string', 'nu.exe: still explains itself');
  eq(s.reason!.includes('Everything else works'), true, 'nu.exe: says it is usable');
}
// POSIX: bash/zsh/fish are the hooked three; nothing is ever "broken" there,
// because the MSYS path problem does not exist. The pairing with
// shellInvocation is asserted too — 'full' is a claim about a hook that has to
// really be injected, and that is the half that would silently rot if one side
// gained a shell the other did not.
for (const cmd of ['bash', '/usr/bin/bash', 'zsh', 'fish', '/opt/homebrew/bin/fish']) {
  eq(describeShellSupport(cmd, false).integration, 'full', `${cmd}: full integration on POSIX`);
  // A hooked invocation carries something the bare one does not — extra args
  // beyond [command, '-i'] (just [command] on Windows), OR an env override.
  // zsh is the reason for the second half: it has no --rcfile equivalent, so its
  // hook rides in entirely through ZDOTDIR and its argv is exactly the bare
  // [command, '-i']. Counting args alone called that "not injected" — on POSIX
  // only, since the Windows baseline of 1 let the same 2 args through.
  const invocation = shellInvocation(cmd);
  const baseline = process.platform === 'win32' ? 1 : 2;
  const injected = invocation.args.length > baseline || invocation.env !== undefined;
  eq(injected, true, `${cmd}: shellInvocation really does inject something`);
}
for (const cmd of ['sh', 'dash', '/bin/tcsh', 'nu']) {
  eq(describeShellSupport(cmd, false).integration, 'none', `${cmd}: no hook, but not broken`);
}
eq(
  describeShellSupport('bash.exe', false).integration,
  'none',
  'a .exe on POSIX keeps its extension and matches nothing — no accidental "full"',
);

console.log(`\n  ${pass} assertions passed\n`);
