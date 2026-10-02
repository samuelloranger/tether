import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { decide, summarize } from './hold'

type World = { runs: string[][]; spawns: string[][] }

function world(
  on: On,
  { wait = '', holdExit = 0, verdict = 'ask', env = { ZMX_SESSION: 'work', HOME: '/home/u' } }:
    { wait?: string; holdExit?: number; verdict?: 'ask' | 'allow' | 'deny'; env?: Record<string, string> } = {},
): World {
  const w: World = { runs: [], spawns: [] }
  mock.env(on, env)
  on('tool.check', () => ({ decision: verdict, reason: 'needs approval' }))
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    const stdout = holdExit === 0 ? 'v1\n' : ''
    return { value: { exitCode: holdExit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$, e) {
    w.spawns.push([...e.argv])
    if (wait) yield { stream: 'stdout' as const, text: wait }
    return { value: { code: 0, signal: null } }
  })
  return w
}

const BASH = { tool: 'Bash', input: { command: 'npm test' } } as const

describe('tool.check', () => {
  test('an approve from the phone allows the call', async ($, on) => {
    const w = world(on, { wait: '{"action":"approve"}\n' })
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
    const r = await $.tool.check(BASH)
    expect(r).toEqual({ decision: 'deny', reason: 'Denied from phone' })
  })

  test('a reply refuses it with the reply as the reason', async ($, on) => {
    world(on, { wait: '{"action":"reply","text":"use pnpm"}\n' })
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('deny')
    expect(r.reason).toBe('Denied from phone, with feedback: use pnpm')
  })

  test('a release leaves the dialog', async ($, on) => {
    world(on, { wait: '{"release":"attached"}\n' })
    const r = await $.tool.check(BASH)
    expect(r).toEqual({ decision: 'ask', reason: 'needs approval' })
  })

  test('an old tether-notify leaves the dialog', async ($, on) => {
    const w = world(on, { holdExit: 2 })
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('ask')
    expect(w.spawns).toEqual([])
  })

  test('a refused hold leaves the dialog', async ($, on) => {
    const w = world(on, { holdExit: 3 })
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.spawns).toEqual([])
  })

  test('outside zmx nothing runs', async ($, on) => {
    const w = world(on, { env: { HOME: '/home/u' } })
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(w.runs).toEqual([])
  })

  test('a call already allowed is left alone', async ($, on) => {
    const w = world(on, { verdict: 'allow' })
    expect((await $.tool.check(BASH)).decision).toBe('allow')
    expect(w.runs).toEqual([])
  })

  test('TETHER_NOTIFY_BIN overrides the binary', async ($, on) => {
    const w = world(on, {
      wait: '{"action":"approve"}\n',
      env: { ZMX_SESSION: 'work', HOME: '/home/u', TETHER_NOTIFY_BIN: '/opt/tn' },
    })
    await $.tool.check(BASH)
    expect(w.runs[0]?.[0]).toBe('/opt/tn')
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
