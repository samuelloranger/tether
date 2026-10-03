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

// In auto, dontAsk and bypass modes the mode itself settles an ask; holding it would
// stall a session no person is meant to answer. An unknown mode errs the same way.
const PERSON_DECIDES = new Set(['default', 'acceptEdits', 'plan'])

export function holdsInMode(mode: string | undefined): boolean {
  return mode === undefined || PERSON_DECIDES.has(mode)
}

export type HeldQuestion = { question: string; header: string }

export function questionBody(questions: readonly HeldQuestion[]): string {
  if (questions.length === 1) return oneLine(questions[0]?.question ?? '')
  return oneLine(`${questions.length} questions: ${questions.map(q => q.header).join(', ')}`)
}

// `wait`'s answers line, or null when it is anything else (a release, a crash).
export function answersFrom(output: string): Record<string, string> | null {
  const line = output.trim().split('\n').pop() ?? ''
  let parsed: { action?: string; answers?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const answers = parsed.answers
  if (parsed.action !== 'answers' || typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null
  const entries = Object.entries(answers)
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}
