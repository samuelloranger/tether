import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './paths';

// Generate a bash rcfile that gives a fish-like prompt: cwd abbreviated to
// first letters (~/S/p/t/a/server), git branch, and a ❯ char. Written to a file
// (not an inlined PS1) so the shell logic stays readable.
// bashrc + holder sockets live alongside the DB (CONFIG_DIR already resolves
// env / installed-binary / dev-source to the right place — see paths.ts).
const RC_DIR = CONFIG_DIR;
export const RC_PATH = path.join(RC_DIR, 'tether.bashrc');
const BASHRC = [
  '[ -f ~/.bashrc ] && source ~/.bashrc',
  '_tether_pwd() {',
  '  local tilde="~" p out="" seg i=0 n',
  '  p="${PWD/#$HOME/$tilde}"', // via var so ~ is not re-expanded back to $HOME
  '  local -a parts',
  '  IFS=/ read -ra parts <<< "$p"',
  '  n=${#parts[@]}',
  '  for seg in "${parts[@]}"; do',
  '    i=$((i+1))',
  '    if [ $i -lt $n ] && [ -n "$seg" ]; then',
  '      if [[ $seg == .* ]]; then out+="${seg:0:2}"; else out+="${seg:0:1}"; fi',
  '    else',
  '      out+="$seg"',
  '    fi',
  '    [ $i -lt $n ] && out+="/"',
  '  done',
  '  printf "%s" "$out"',
  '}',
  '_tether_branch() { local b; b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && printf " (%s)" "$b"; }',
  '_tether_osc7() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"; }',
  "PS1='\\[$(_tether_osc7)\\]\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
mkdirSync(RC_DIR, { recursive: true, mode: 0o700 });
// Tighten an existing dir too — the config dir holds the argon2 hash and the
// holder IPC sockets, so no other local user should be able to traverse it.
try {
  chmodSync(RC_DIR, 0o700);
} catch {}
writeFileSync(RC_PATH, BASHRC);

// zsh has no --rcfile-equivalent flag for interactive mode; the standard,
// safe (zsh-only, unlike XDG_CONFIG_HOME) redirect is the ZDOTDIR env var,
// which zsh reads $ZDOTDIR/.zshrc from instead of ~/.zshrc. Only the invisible
// OSC 7 hook is added — no prompt replacement, since zsh users already have
// their own (bare `~/.zshrc`, not `$ZDOTDIR`-relative, so a customized
// ZDOTDIR of the user's own is intentionally not chased here — same
// simplification the bash rcfile already makes for ~/.bashrc).
export const ZSH_RC_DIR = path.join(RC_DIR, 'zsh');
const ZSHRC = [
  '[ -f ~/.zshrc ] && source ~/.zshrc',
  '_tether_osc7() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"; }',
  'precmd_functions+=(_tether_osc7)',
  '',
].join('\n');
// ZDOTDIR redirects ALL of zsh's startup files, not just .zshrc — .zshenv is
// read even for non-interactive shells and is the canonical place users put
// PATH/SDK-manager/Nix env setup (zsh does not fall back to ~/.zshenv once
// ZDOTDIR is set, so without this that setup would silently vanish).
const ZSHENV = '[ -f ~/.zshenv ] && source ~/.zshenv\n';
mkdirSync(ZSH_RC_DIR, { recursive: true });
writeFileSync(path.join(ZSH_RC_DIR, '.zshrc'), ZSHRC);
writeFileSync(path.join(ZSH_RC_DIR, '.zshenv'), ZSHENV);

// fish has no rcfile-redirect env var without risking collateral effects on
// other XDG-aware tools in the session (XDG_CONFIG_HOME would redirect ALL of
// them, not just fish) — --init-command runs before fish's own config.fish,
// with no environment side effects at all.
export const FISH_INIT =
  'function _tether_osc7 --on-event fish_prompt; printf "\\e]7;file://%s%s\\a" (hostname) (pwd); end';

export interface ShellInvocation {
  args: string[];
  env?: Record<string, string>;
}

// Picks the spawn args (and any env override) that wire up shell integration
// (currently just OSC 7 cwd tracking) for the given command, per-shell since
// each needs a different injection mechanism — bash's --rcfile, zsh's ZDOTDIR
// redirect, fish's --init-command. Anything else runs as-is (matches the
// pre-existing fallback: no shell integration attempted).
export function shellInvocation(command: string): ShellInvocation {
  // Dispatch matches on basename, but argv[0] keeps the original (possibly
  // absolute, e.g. /opt/homebrew/bin/fish) command — the daemon's own PATH may
  // not include the shell's install directory even when the resolved login
  // shell (getDefaultShell(), read from /etc/passwd) does exist at that path.
  const shell = path.basename(command);
  if (shell === 'bash') return { args: [command, '--rcfile', RC_PATH, '-i'] };
  if (shell === 'zsh') return { args: [command, '-i'], env: { ZDOTDIR: ZSH_RC_DIR } };
  if (shell === 'fish') return { args: [command, '--init-command', FISH_INIT, '-i'] };
  return { args: [command, '-i'] };
}

export function getDefaultShell(): string {
  try {
    const username = userInfo().username;
    const passwd = readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === username && parts[6]) {
        return parts[6];
      }
    }
  } catch {}
  return process.env.SHELL || 'bash';
}
