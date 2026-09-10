import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessageRow } from './agentMessages';

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

/** Absolute path of a session's transcript file for a given cwd. */
export function sessionJsonlPath(cwd: string, id: string, projectsDir?: string): string {
  return join(projectsDir ?? defaultProjectsDir(), slugForCwd(cwd), `${id}.jsonl`);
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

export interface TranslatedMessage {
  kind: AgentMessageRow['kind'];
  text?: string;
  toolJson?: string;
  isError?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => (b as { type?: string }).type === 'text') as
      | { text?: string }
      | undefined;
    return block?.text ?? '';
  }
  return '';
}

/**
 * Turn a persisted Claude session `.jsonl` into stored agent-message rows so a
 * resumed chat can replay its history. Tolerant by design (unknown/corrupt lines
 * are skipped, never thrown) since the file shape drifts across CLI versions,
 * and capped to the last `maxTurns` rows so a huge session degrades gracefully.
 */
export function translateSessionJsonl(
  path: string,
  opts?: { maxTurns?: number },
): TranslatedMessage[] {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const rows: TranslatedMessage[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain === true) continue;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    const content = message.content;
    if (message.role === 'user') {
      if (typeof content === 'string') {
        rows.push({ kind: 'user', text: content });
      } else if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_result') {
            rows.push({
              kind: 'tool_result',
              text: textOf(b.content),
              isError: b.is_error === true,
            });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            rows.push({ kind: 'user', text: b.text });
          }
        }
      }
    } else if (message.role === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') {
          rows.push({ kind: 'delta', text: b.text });
        } else if (b.type === 'tool_use') {
          rows.push({
            kind: 'tool',
            toolJson: JSON.stringify({ name: b.name ?? '', input: b.input ?? {} }),
          });
        }
      }
    }
  }
  const maxTurns = opts?.maxTurns ?? 400;
  return rows.length > maxTurns ? rows.slice(rows.length - maxTurns) : rows;
}
