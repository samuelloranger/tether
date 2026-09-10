import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSessionMeta {
  id: string;
  label: string;
  mtimeMs: number;
  msgCount: number;
  cwd: string;
}

/** Claude Code's per-project dir name: every `/` in the cwd becomes `-`. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Best-effort last user-message text + a user-message count for a session file. */
function labelFor(path: string): { label: string; msgCount: number } {
  let label = '';
  let msgCount = 0;
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const message = obj.message as { role?: string; content?: unknown } | undefined;
      if (message?.role !== 'user') continue;
      msgCount += 1;
      const content = message.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? ((
                content.find((b) => (b as { type?: string }).type === 'text') as
                  | { text?: string }
                  | undefined
              )?.text ?? '')
            : '';
      if (text) label = text;
    }
  } catch {
    // Unreadable file → empty label; the caller still lists it by id.
  }
  return { label: label.slice(0, 120), msgCount };
}

export function listClaudeSessions(
  cwd: string,
  opts?: { projectsDir?: string; cap?: number },
): ClaudeSessionMeta[] {
  const dir = join(opts?.projectsDir ?? defaultProjectsDir(), slugForCwd(cwd));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: ClaudeSessionMeta[] = names.map((n) => {
    const path = join(dir, n);
    const { label, msgCount } = labelFor(path);
    return { id: n.replace(/\.jsonl$/, ''), label, msgCount, cwd, mtimeMs: statSync(path).mtimeMs };
  });
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, opts?.cap ?? 50);
}
