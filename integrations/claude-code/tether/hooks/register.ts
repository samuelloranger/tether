import type { Register } from 'claude-code'
import { decide, holdsInMode, summarize } from './hold'

let interactive = false
// tool.check doesn't carry the permission mode; these classic events do, so the latest
// one stands in for it (a mode switched mid-turn lands with the next tool's result).
let mode: string | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
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

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool === 'AskUserQuestion') return verdict
    // No id: another plugin's query about a call that may never run.
    if (!e.tool_use_id || !interactive) return verdict
    if (!holdsInMode(mode)) return verdict
    const session = await $.env.get('ZMX_SESSION')
    const home = await $.env.get('HOME')
    if (!session || !home) return verdict
    // A multiplexer started inside the zmx session can show this agent while zmx
    // itself reads as detached.
    if ((await $.env.get('TMUX')) || (await $.env.get('STY'))) return verdict
    const notify = (await $.env.get('TETHER_NOTIFY_BIN')) ?? `${home}/.local/bin/tether-notify`
    try {
      const held = await $.process.run([
        notify, 'hold', '--session', session, '--kind', 'permission',
        '--tool', e.tool, '--body', summarize(e.tool, e.input),
      ])
      if (held.exitCode !== 0) return verdict
      const version = held.stdout.trim()
      $.ui.status('waiting on phone')
      let output = ''
      for await (const chunk of $.process.spawn({ argv: [notify, 'wait', '--session', session, '--version', version] })) {
        if (chunk.stream === 'stdout') output += chunk.text
      }
      return decide(output, verdict)
    } catch {
      // Esc aborts the dispatch and kills `wait`; a missing binary can't start. Either
      // way the agent's own dialog is the answer.
      return verdict
    } finally {
      $.ui.status(undefined)
    }
  })
}
