import { addTerminalLog, upsertSession, clearLogs, setSessionStatus } from './db';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Generate a bash rcfile that gives a fish-like prompt: cwd abbreviated to
// first letters (~/S/p/t/a/server), git branch, and a ❯ char. Written to a file
// (not an inlined PS1) so the shell logic stays readable.
const RC_DIR = path.join(process.cwd(), 'config');
const RC_PATH = path.join(RC_DIR, 'tether.bashrc');
const BASHRC = [
  '[ -f ~/.bashrc ] && source ~/.bashrc',
  '_tether_pwd() {',
  '  local tilde="~" p out="" seg i=0 n',
  '  p="${PWD/#$HOME/$tilde}"',  // via var so ~ is not re-expanded back to $HOME
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
  "PS1='\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
mkdirSync(RC_DIR, { recursive: true });
writeFileSync(RC_PATH, BASHRC);

interface SessionInstance {
  process: any;
  subscribers: Set<(data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number; id?: number }) => void>;
}

const instances = new Map<string, SessionInstance>();

export function startSession(
  id: string,
  command: string = 'bash',
  cols: number = 80,
  rows: number = 24
) {
  if (instances.has(id)) {
    return instances.get(id)!;
  }

  // Ensure session exists in DB
  upsertSession(id, command, 'running');

  // Per-session streaming decoder: buffers incomplete multi-byte UTF-8 sequences
  // across PTY read chunks so split emoji/wide glyphs don't decode to U+FFFD (�).
  const decoder = new TextDecoder('utf-8');

  // Spawn the child process using Bun's native PTY support.
  // For bash, load our rcfile for the fish-like prompt (still sources the user's
  // ~/.bashrc). Any other command runs as-is. TERM enables 256-color output.
  // ponytail: bash-only default; a user wanting zsh/fish sets `command` instead.
  const args = command === 'bash' ? ['bash', '--rcfile', RC_PATH, '-i'] : [command];
  const proc = Bun.spawn(args, {
    cwd: process.env.HOME || homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
    },
    terminal: {
      cols,
      rows,
      data(terminal, uint8Array) {
        const text = decoder.decode(uint8Array, { stream: true });
        
        // Write to DB and capture insert row ID
        const logId = addTerminalLog(id, text);

        // Notify active subscribers
        const inst = instances.get(id);
        if (inst) {
          for (const sub of inst.subscribers) {
            try {
              sub({ type: 'output', chunk: text, id: logId });
            } catch (err) {
              console.error(`Error sending PTY output to session subscriber "${id}":`, err);
            }
          }
        }
      },
    },
  });

  const instance: SessionInstance = {
    process: proc,
    subscribers: new Set(),
  };

  instances.set(id, instance);

  // Handle termination
  proc.exited.then((code) => {
    console.log(`PTY process for session "${id}" exited with code ${code}`);
    upsertSession(id, command, 'stopped');

    const inst = instances.get(id);
    if (inst) {
      for (const sub of inst.subscribers) {
        try {
          sub({ type: 'exit', exitCode: code });
        } catch (err) {
          console.error(`Error sending PTY exit to session subscriber "${id}":`, err);
        }
      }
      inst.subscribers.clear();
    }
    instances.delete(id);
  });

  return instance;
}

export function writeToSession(id: string, text: string) {
  const instance = instances.get(id);
  if (instance && instance.process.terminal) {
    instance.process.terminal.write(text);
    return true;
  }
  return false;
}

export function resizeSession(id: string, cols: number, rows: number) {
  const instance = instances.get(id);
  if (instance && instance.process.terminal) {
    try {
      instance.process.terminal.resize(cols, rows);
      return true;
    } catch (e) {
      console.error(`Failed to resize terminal for session "${id}":`, e);
    }
  }
  return false;
}

export function subscribeToSession(
  id: string,
  callback: (data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number }) => void
) {
  const instance = instances.get(id);
  if (instance) {
    instance.subscribers.add(callback);
    return () => {
      instance.subscribers.delete(callback);
    };
  }
  return () => {};
}

export function killSession(id: string) {
  const instance = instances.get(id);
  if (instance) {
    instance.process.kill();
    instances.delete(id);
  }
  // Mark stopped (without wiping the stored command) and clear scrollback so a
  // restarted session starts with a clean screen instead of replaying history.
  setSessionStatus(id, 'stopped');
  clearLogs(id);
  return instance ? true : false;
}

export function getActiveSession(id: string) {
  return instances.get(id);
}
