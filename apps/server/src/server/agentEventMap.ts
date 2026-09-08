import type { AgentEvent, AgentFrame } from './agentDriver';

export class FrameSeq {
  private n = 0;
  next(): number {
    return ++this.n;
  }
}

export function toFrame(ev: AgentEvent, seq: FrameSeq): AgentFrame {
  switch (ev.t) {
    case 'delta':
      return { t: 'agent.delta', seq: seq.next(), text: ev.text };
    case 'tool':
      return { t: 'agent.tool', seq: seq.next(), name: ev.name, input: ev.input };
    case 'tool_result':
      return { t: 'agent.tool_result', seq: seq.next(), text: ev.text, isError: ev.isError };
    case 'done':
      return { t: 'agent.done', seq: seq.next(), cost: ev.cost, usage: ev.usage };
    case 'permission_req':
      return { t: 'agent.permission_req', reqId: ev.reqId, name: ev.name, input: ev.input };
    case 'error':
      return { t: 'agent.error', message: ev.message };
  }
}
