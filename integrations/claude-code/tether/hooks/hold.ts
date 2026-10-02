export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }

const BODY_LIMIT = 120

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_LIMIT ? `${flat.slice(0, BODY_LIMIT - 1)}…` : flat
}

export function summarize(tool: string, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const arg = [fields.command, fields.file_path, fields.notebook_path, fields.url]
    .find((v): v is string => typeof v === 'string' && v !== '')
  return oneLine(arg ? `Allow ${tool}: ${arg}?` : `Allow ${tool}?`)
}

// `wait` prints one JSON line; anything else (a release, a crash) keeps the dialog.
export function decide(output: string, verdict: Verdict): Verdict {
  const line = output.trim().split('\n').pop() ?? ''
  let answer: { action?: string; text?: string }
  try {
    answer = JSON.parse(line)
  } catch {
    return verdict
  }
  switch (answer.action) {
    case 'approve':
      return { decision: 'allow', reason: 'Approved from phone' }
    case 'deny':
      return { decision: 'deny', reason: 'Denied from phone' }
    case 'reply':
      return { decision: 'deny', reason: `Denied from phone, with feedback: ${answer.text ?? ''}` }
  }
  return verdict
}
