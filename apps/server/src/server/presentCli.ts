import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type PresentArgs =
  | { kind: 'open'; entry: string; project?: string; title?: string }
  | { kind: 'reset'; project?: string }
  | { kind: 'agent-install'; target?: 'codex' | 'claude' };

export function parsePresentArgs(argv: string[]): PresentArgs {
  if (argv[0] === 'reset') {
    if (argv.length > 2) throw new Error('Usage: tether present reset [project-name]');
    return argv[1] ? { kind: 'reset', project: argv[1] } : { kind: 'reset' };
  }
  if (argv[0] === 'agent-install') {
    const target = argv[1];
    if (argv.length > 2 || (target && target !== 'codex' && target !== 'claude')) {
      throw new Error('Usage: tether present agent-install [codex|claude]');
    }
    return target
      ? { kind: 'agent-install', target: target as 'codex' | 'claude' }
      : { kind: 'agent-install' };
  }
  if (!argv[0] || argv[0].startsWith('-') || argv[0].startsWith('agent-')) {
    throw new Error('Unknown present command');
  }
  const out: Extract<PresentArgs, { kind: 'open' }> = { kind: 'open', entry: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (!value || (argv[i] !== '--project' && argv[i] !== '--title'))
      throw new Error('Unknown present command');
    if (argv[i] === '--project') out.project = value;
    if (argv[i] === '--title') out.title = value;
  }
  return out;
}

export interface InstallDeps {
  home?: string;
  hasCommand: (name: string) => boolean;
}

export interface PresentDeps {
  port: string;
  tokenFile: string;
  // Just the call signature we use — not `typeof fetch`, whose extra members
  // (preconnect) a plain test double has no reason to implement.
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  hasCommand?: (name: string) => boolean;
}

export async function runPresent(args: PresentArgs, deps: PresentDeps): Promise<void> {
  if (args.kind === 'agent-install') {
    const hasCommand = deps.hasCommand ?? ((name: string) => Bun.which(name) !== null);
    const targets = args.target ? [args.target] : (['codex', 'claude'] as const).filter(hasCommand);
    if (!targets.length) throw new Error('Neither codex nor claude is installed');
    for (const target of targets)
      console.log(`Installed ${target} skill: ${installAgentSkill(target, { hasCommand })}`);
    return;
  }
  const token = readFileSync(deps.tokenFile, 'utf8').trim();
  const endpoint =
    args.kind === 'reset' ? '/control/presentations/reset' : '/control/presentations';
  // Resolve here, against this short-lived CLI process's own cwd — the entry
  // arg is relative to the invoking shell, not the long-running daemon's cwd,
  // which is wherever the daemon happened to be started from.
  const body =
    args.kind === 'reset'
      ? { project: args.project }
      : {
          entry: path.resolve(args.entry),
          project: args.project,
          title: args.title,
          sessionId: process.env.TETHER_SESSION_ID,
        };
  const res = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tether-Present-Control': token },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tether preview request failed (${res.status}). Is tether running?`);
  console.log(args.kind === 'reset' ? 'Previews cleared.' : 'Preview opened.');
}

const SKILL = `---
name: tether-present
description: Present an HTML UI preview to the Tether user. Use when a coding task benefits from showing a visual preview.
---

Create a self-contained HTML preview directory. Run \`tether present <entry.html> --project <project-name> --title <title>\` to show it in Tether. When the preview is accepted or abandoned, run \`tether present reset <project-name>\`. Pages are display-only and may only load files below their preview directory.
`;

export function installAgentSkill(target: 'codex' | 'claude', deps: InstallDeps): string {
  if (!deps.hasCommand(target)) throw new Error(`${target} is not installed`);
  const home = deps.home ?? homedir();
  const dir =
    target === 'codex'
      ? path.join(home, '.agents', 'skills', 'tether-present')
      : path.join(home, '.claude', 'skills', 'tether-present');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, SKILL);
  return file;
}
