import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { decide, holdsInMode, questionBody, summarize } from './hold'

type World = { runs: string[][]; stdins: (string | undefined)[]; spawns: string[][]; calls: unknown[]; waitsEnded: number }

function world(
  on: On,
  { wait = '', holdExit = 0, verdict = 'ask', env = { ZMX_SESSION: 'work', HOME: '/home/u' }, defaultMode, dialog = 'answers', waitHangs = false }:
    { wait?: string; holdExit?: number; verdict?: 'ask' | 'allow' | 'deny'; env?: Record<string, string>; defaultMode?: string;
      dialog?: 'answers' | 'never'; waitHangs?: boolean } = {},
): World {
  const w: World = { runs: [], stdins: [], spawns: [], calls: [], waitsEnded: 0 }
  mock.env(on, env)
  on('session.start', () => ({ cwd: '/x' }))
  on('settings.read', () => ({ value: defaultMode ? { permissions: { defaultMode } } : {} }) as never)
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('tool.check', () => ({ decision: verdict, reason: 'needs approval' }))
  // Beneath the mod's tool.call is Claude's own dialog.
  on('tool.call', (_$, e) => {
    w.calls.push(e)
    if (dialog === 'never') return new Promise(() => {}) as never
    return { result: 'the dialog answered' } as never
  })
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    w.stdins.push(e.init?.stdin as string | undefined)
    const stdout = holdExit === 0 ? 'v1\n' : ''
    return { value: { exitCode: holdExit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$, e) {
    w.spawns.push([...e.argv])
    try {
      // `wait` announces its claim first, unless it found nothing to hold.
      if (!wait.includes('"release"')) yield { stream: 'stdout' as const, text: '{"claimed":true}\n' }
      // A live `wait` that never answers: it only ends when the mod stops it.
      while (waitHangs) yield { stream: 'stderr' as const, text: '.' }
      if (wait) yield { stream: 'stdout' as const, text: wait }
      return { value: { code: 0, signal: null } }
    } finally {
      w.waitsEnded += 1
    }
  })
  return w
}

// A real call carries the engine's tool_use_id; a plugin's permission query does not.
const BASH = { tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_1' } as never
const QUERY = { tool: 'Bash', input: { command: 'npm test' } } as const

type Engine = { session: { start: (e: never) => Promise<unknown> } }

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/x', surface: null, isInteractive } as never)
}

describe('tool.check', () => {
  test('an approve from the phone allows the call', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    await start($)
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('allow')
    expect(w.runs).toEqual([[
      '/home/u/.local/bin/tether-notify', 'hold', '--session', 'work', '--kind', 'permission',
      '--tool', 'Bash', '--body', 'Allow Bash: npm test?',
    ]])
    expect(w.spawns).toEqual([['/home/u/.local/bin/tether-notify', 'wait', '--session', 'work', '--version', 'v1']])
  })

  test('a deny from the phone refuses it', async ($, on) => {
    world(on, { wait: '{"action":"deny"}\n' })
    await start($)
    const r = await $.tool.check(BASH)
    expect(r).toEqual({ decision: 'deny', reason: 'Denied from phone' })
  })

  test('a reply refuses it with the reply as the reason', async ($, on) => {
    world(on, { wait: '{"action":"reply","text":"use pnpm"}\n' })
    await start($)
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('deny')
    expect(r.reason).toBe('Denied from phone, with feedback: use pnpm')
  })

  test('a release leaves the dialog', async ($, on) => {
    const w = world(on, { wait: '{"release":"attached"}\n' })
    await start($)
    const r = await $.tool.check(BASH)
    expect(r).toEqual({ decision: 'ask', reason: 'needs approval' })
    expect(w.spawns.length).toBe(1)
  })

  test('an old tether-notify leaves the dialog', async ($, on) => {
    const w = world(on, { holdExit: 2 })
    await start($)
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('ask')
    expect(w.runs.length).toBe(1)
    expect(w.spawns).toEqual([])
  })

  test('a refused hold leaves the dialog', async ($, on) => {
    const w = world(on, { holdExit: 3 })
    await start($)
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs.length).toBe(1)
    expect(w.spawns).toEqual([])
  })

  test('outside zmx nothing runs', async ($, on) => {
    const w = world(on, { env: { HOME: '/home/u' } })
    await start($)
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  for (const [name, value] of [['TMUX', '/tmp/tmux-1000/default,1,0'], ['STY', '123.pts-0.host']]) {
    test(`inside ${name} nothing runs: someone may be at that terminal`, async ($, on) => {
      const w = world(on, { env: { ZMX_SESSION: 'work', HOME: '/home/u', [name as string]: value as string } })
      await start($)
      expect((await $.tool.check(BASH)).decision).toBe('ask')
      expect(w.runs).toEqual([])
    })
  }

  test('a non-interactive session is never held', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    await start($, false)
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('before session.start nothing is held', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('a mode that settles asks on its own is never held', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'auto' } as never)
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('a settings default mode that settles asks is never held', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n', defaultMode: 'dontAsk' })
    await start($)
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('the latest mode wins: back to default after a tool holds again', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'dontAsk' } as never)
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't0', permission_mode: 'default' } as never)
    expect((await $.tool.check(BASH)).decision).toBe('allow')
    expect(w.runs.length).toBe(1)
  })

  test("a plugin's permission query is never held", async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
    await start($)
    expect((await $.tool.check(QUERY)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('a call already allowed is left alone', async ($, on) => {
    const w = world(on, { verdict: 'allow' })
    await start($)
    expect((await $.tool.check(BASH)).decision).toBe('allow')
    expect(w.runs).toEqual([])
  })

  test('TETHER_NOTIFY_BIN overrides the binary', async ($, on) => {
    const w = world(on, {
      wait: '{"action":"approve"}\n',
      env: { ZMX_SESSION: 'work', HOME: '/home/u', TETHER_NOTIFY_BIN: '/opt/tn' },
    })
    await start($)
    await $.tool.check(BASH)
    expect(w.runs[0]?.[0]).toBe('/opt/tn')
  })
})

describe('holdsInMode', () => {
  test('modes a person decides in hold; modes that decide on their own do not', () => {
    for (const mode of [undefined, 'default', 'acceptEdits', 'plan']) expect(holdsInMode(mode)).toBe(true)
    for (const mode of ['auto', 'dontAsk', 'bypassPermissions', 'something-new']) expect(holdsInMode(mode)).toBe(false)
  })
})

describe('summarize', () => {
  test('names the main argument', () => {
    expect(summarize('Bash', { command: 'git push' })).toBe('Allow Bash: git push?')
    expect(summarize('Edit', { file_path: '/src/a.ts', old_string: 'x' })).toBe('Allow Edit: /src/a.ts?')
    expect(summarize('WebFetch', { url: 'https://example.com' })).toBe('Allow WebFetch: https://example.com?')
    expect(summarize('mcp__srv__do', {})).toBe('Allow mcp__srv__do?')
  })

  test('keeps one short line', () => {
    const body = summarize('Bash', { command: 'echo a\n\techo b ' + 'x'.repeat(300) })
    expect(body.includes('\n')).toBe(false)
    expect(body.length).toBe(120)
    expect(body.endsWith('…')).toBe(true)
  })
})

describe('decide', () => {
  const ask = { decision: 'ask' as const, reason: 'r' }
  test('garbage and releases keep the verdict', () => {
    expect(decide('', ask)).toEqual(ask)
    expect(decide('not json', ask)).toEqual(ask)
    expect(decide('{"release":"stale"}\n', ask)).toEqual(ask)
    expect(decide('{"action":"maybe"}', ask)).toEqual(ask)
  })
})

const QUESTIONS = [
  { question: 'Which fruits?', header: 'Fruit', multiSelect: true,
    options: [{ label: 'Apple', description: 'crisp' }, { label: 'Pear', description: 'soft', preview: 'x' }] },
  { question: 'Which color?', header: 'Color', multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
]
const ASK = { tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'toolu_q' } as never
const ANSWERS = { 'Which fruits?': 'Apple, Pear', 'Which color?': 'Blue' }

describe('AskUserQuestion', () => {
  test('the phone answering first becomes the tool result and closes the dialog', async ($, on) => {
    const w = world(on, { wait: JSON.stringify({ action: 'answers', answers: ANSWERS }) + '\n', dialog: 'never' })
    await start($)
    const r = await $.tool.call(ASK)
    expect(r).toEqual({ result: { questions: QUESTIONS, answers: ANSWERS } })
    expect(w.calls.length).toBe(1)
    expect(w.runs).toEqual([[
      '/home/u/.local/bin/tether-notify', 'hold', '--session', 'work', '--kind', 'question',
      '--tool', 'AskUserQuestion', '--body', '2 questions: Fruit, Color', '--questions-stdin',
    ]])
    expect(JSON.parse(w.stdins[0] ?? '')).toEqual([
      { question: 'Which fruits?', header: 'Fruit', multiSelect: true,
        options: [{ label: 'Apple', description: 'crisp' }, { label: 'Pear', description: 'soft' }] },
      { question: 'Which color?', header: 'Color', multiSelect: false,
        options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
    ])
  })

  test('the dialog answering first wins and the wait is stopped', async ($, on) => {
    const w = world(on, { waitHangs: true })
    await start($)
    expect(await $.tool.call(ASK)).toEqual({ result: 'the dialog answered' })
    expect(w.spawns.length).toBe(1)
    // Stopping the child is asynchronous; give it a few turns.
    for (let i = 0; i < 200 && w.waitsEnded === 0; i++) await Promise.resolve()
    expect(w.waitsEnded).toBe(1)
  })

  test('a release leaves the answer to the dialog', async ($, on) => {
    const w = world(on, { wait: '{"release":"stale"}\n' })
    await start($)
    expect(await $.tool.call(ASK)).toEqual({ result: 'the dialog answered' })
    expect(w.calls.length).toBe(1)
  })

  test('a refused hold just shows the dialog', async ($, on) => {
    const w = world(on, { holdExit: 3 })
    await start($)
    expect(await $.tool.call(ASK)).toEqual({ result: 'the dialog answered' })
    expect(w.spawns).toEqual([])
  })

  test('questions are recorded in bypass mode too: a question always needs a person', async ($, on) => {
    const w = world(on, { wait: JSON.stringify({ action: 'answers', answers: ANSWERS }) + '\n', dialog: 'never', defaultMode: 'bypassPermissions' })
    await start($)
    expect(await $.tool.call(ASK)).toEqual({ result: { questions: QUESTIONS, answers: ANSWERS } })
    expect(w.runs.length).toBe(1)
  })

  test('a non-interactive session asks in the terminal only', async ($, on) => {
    const w = world(on, { wait: '{"action":"answers","answers":{}}\n' })
    await start($, false)
    await $.tool.call(ASK)
    expect(w.runs).toEqual([])
    expect(w.calls.length).toBe(1)
  })

  test('inside tmux the dialog stays alone', async ($, on) => {
    const w = world(on, { env: { ZMX_SESSION: 'work', HOME: '/home/u', TMUX: '/tmp/t,1,0' } })
    await start($)
    await $.tool.call(ASK)
    expect(w.runs).toEqual([])
  })

  test('outside zmx the dialog stays alone', async ($, on) => {
    const w = world(on, { env: { HOME: '/home/u' } })
    await start($)
    await $.tool.call(ASK)
    expect(w.runs).toEqual([])
  })

  test('answers that are not an object leave the answer to the dialog', async ($, on) => {
    const w = world(on, { wait: '{"action":"answers","answers":"nope"}\n' })
    await start($)
    expect(await $.tool.call(ASK)).toEqual({ result: 'the dialog answered' })
    expect(w.calls.length).toBe(1)
  })
})

describe('questionBody', () => {
  test('one question is its text; several name their headers', () => {
    expect(questionBody([{ question: 'Which DB?', header: 'DB' }])).toBe('Which DB?')
    expect(questionBody([{ question: 'a?', header: 'A' }, { question: 'b?', header: 'B' }])).toBe('2 questions: A, B')
  })
})
