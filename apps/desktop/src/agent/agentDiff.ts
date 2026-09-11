import type { DerivedDiff, DiffHunk, DiffLine } from './agentTypes';

/**
 * Minimal single-hunk line diff (LCS over lines, not full Myers) between two
 * blobs, so an Edit/Write tool call renders as a diff instead of raw JSON.
 * Port of Swift unifiedLineDiff (AgentDiff.swift:7). Returns [] when nothing
 * changed.
 */
export function unifiedLineDiff(oldText: string, newText: string): DiffHunk[] {
  if (oldText === '') {
    if (newText === '') return [];
    const lines: DiffLine[] = newText.split('\n').map((text) => ({ kind: 'add', text }));
    return [{ lines }];
  }
  if (newText === '') {
    const lines: DiffLine[] = oldText.split('\n').map((text) => ({ kind: 'del', text }));
    return [{ lines }];
  }

  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = lcsDiffOps(a, b);
  if (!ops.some((l) => l.kind !== 'context')) return [];
  return [{ lines: ops }];
}

function lcsDiffOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

/** One-line summary of a tool call from its input. Port of Swift summarize
 * (AgentChatModel.swift:251). */
export function summarize(name: string, inputJson: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(inputJson);
  } catch {
    return name;
  }
  const str = (k: string): string | undefined => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
      return str('command') ?? name;
    case 'read':
    case 'edit':
    case 'write':
    case 'multiedit':
      return str('file_path') ?? name;
    case 'grep':
    case 'glob':
      return str('pattern') ?? name;
    default:
      return name;
  }
}

/**
 * Synthesize a diff from an Edit/Write/MultiEdit tool's inputJson.
 * Port of Swift derivedDiff (AgentChatModel.swift:265).
 */
export function deriveDiff(name: string, inputJson: string): DerivedDiff | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(inputJson);
  } catch {
    return undefined;
  }
  const path = typeof obj.file_path === 'string' ? obj.file_path : name;
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

  switch (name.toLowerCase()) {
    case 'edit': {
      const hunks = unifiedLineDiff(str('old_string'), str('new_string'));
      return hunks.length ? { path, hunks } : undefined;
    }
    case 'write': {
      const hunks = unifiedLineDiff('', str('content'));
      return hunks.length ? { path, hunks } : undefined;
    }
    case 'multiedit': {
      const edits = Array.isArray(obj.edits) ? (obj.edits as Record<string, unknown>[]) : [];
      const lines = edits.flatMap((e) => {
        const o = typeof e.old_string === 'string' ? e.old_string : '';
        const n = typeof e.new_string === 'string' ? e.new_string : '';
        return unifiedLineDiff(o, n).flatMap((h) => h.lines);
      });
      return lines.length ? { path, hunks: [{ lines }] } : undefined;
    }
    default:
      return undefined;
  }
}
