import type { EngineInterface, Register } from 'claude-code'
import { answersFrom, decide, holdsInMode, questionBody, summarize } from './hold'

let interactive = false
// tool.check doesn't carry the permission mode. The classic events do, so the latest
// one stands in for it; where an organization's guard keeps classic events from user
// mods, the settings' default mode is all there is (a mode picked by flag or shift+tab
// then goes unseen, and its asks are held like any other).
let mode: string | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    try {
      const settings = (await $.settings.read()) as { permissions?: { defaultMode?: string } }
      mode = settings.permissions?.defaultMode
    } catch {
      mode = undefined
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    mode = e.permission_mode
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    mode = e.permission_mode
    return next(e)
  })
  on('classic.PostToolUse', async ($, e, next) => {
    mode = e.permission_mode
    return next(e)
  })

  // A question always needs a person, so unlike a permission ask it is held in any mode.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!e.tool_use_id || !interactive) return next(e)
    const where = await phoneTarget($)
    if (!where) return next(e)
    const questions = e.questions.map(q => ({
      question: q.question, header: q.header, multiSelect: q.multiSelect,
      options: q.options.map(o => ({ label: o.label, description: o.description })),
    }))
    try {
      const held = await $.process.run([
        where.notify, 'hold', '--session', where.session, '--kind', 'question',
        '--tool', 'AskUserQuestion', '--body', questionBody(questions), '--questions-stdin',
      ], { stdin: JSON.stringify(questions) })
      if (held.exitCode !== 0) return next(e)
      $.ui.status('waiting on phone')
      const output = await waitFor($, where, held.stdout.trim())
      const answers = answersFrom(output)
      if (!answers) return next(e)
      return { result: { questions: e.questions, answers } }
    } catch {
      return next(e)
    } finally {
      $.ui.status(undefined)
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool === 'AskUserQuestion') return verdict
    // No id: another plugin's query about a call that may never run.
    if (!e.tool_use_id || !interactive) return verdict
    if (!holdsInMode(mode)) return verdict
    const where = await phoneTarget($)
    if (!where) return verdict
    try {
      const held = await $.process.run([
        where.notify, 'hold', '--session', where.session, '--kind', 'permission',
        '--tool', e.tool, '--body', summarize(e.tool, e.input),
      ])
      if (held.exitCode !== 0) return verdict
      $.ui.status('waiting on phone')
      return decide(await waitFor($, where, held.stdout.trim()), verdict)
    } catch {
      // Esc aborts the dispatch and kills `wait`; a missing binary can't start. Either
      // way the agent's own dialog is the answer.
      return verdict
    } finally {
      $.ui.status(undefined)
    }
  })
}

type Target = { session: string; notify: string }

// The zmx session to hold for, or null when the phone isn't the right place to ask.
async function phoneTarget($: EngineInterface): Promise<Target | null> {
  const session = await $.env.get('ZMX_SESSION')
  const home = await $.env.get('HOME')
  if (!session || !home) return null
  // A multiplexer started inside the zmx session can show this agent while zmx
  // itself reads as detached.
  if ((await $.env.get('TMUX')) || (await $.env.get('STY'))) return null
  const notify = (await $.env.get('TETHER_NOTIFY_BIN')) ?? `${home}/.local/bin/tether-notify`
  return { session, notify }
}

async function waitFor($: EngineInterface, where: Target, version: string): Promise<string> {
  let output = ''
  for await (const chunk of $.process.spawn({ argv: [where.notify, 'wait', '--session', where.session, '--version', version] })) {
    if (chunk.stream === 'stdout') output += chunk.text
  }
  return output
}
