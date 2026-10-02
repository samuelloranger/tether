import type { Register } from 'claude-code'
import { decide, summarize } from './hold'

export const register: Register = on => {
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool === 'AskUserQuestion') return verdict
    const session = await $.env.get('ZMX_SESSION')
    const home = await $.env.get('HOME')
    if (!session || !home) return verdict
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
