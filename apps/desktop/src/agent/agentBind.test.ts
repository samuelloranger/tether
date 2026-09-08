import { describe, expect, test } from 'bun:test';
import type { CoreConnectParams, TerminalSocket, TransportHandlers } from '../coreTransport';
import { type AgentOpener, bindAgentSession } from './agentBind';
import { AgentChatModel } from './agentChatModel';

function fakeOpener() {
  const sent: string[] = [];
  let captured: TransportHandlers | null = null;
  let lastParams: CoreConnectParams | null = null;
  const socket: TerminalSocket = {
    send: (t) => sent.push(t),
    close: () => {},
  };
  const open: AgentOpener = async (_c, _h, _a, params, handlers) => {
    captured = handlers;
    lastParams = params;
    return socket;
  };
  return {
    open,
    sent,
    params: () => lastParams,
    handlers: () => captured!,
  };
}

describe('bindAgentSession', () => {
  test('routes server frames into the reducer', async () => {
    const model = new AgentChatModel();
    const f = fakeOpener();
    bindAgentSession({ model, hostId: 'h', sessionId: 's1', noiseAddress: 'ws://x', open: f.open });
    await Promise.resolve();
    f.handlers().onMessage('{"t":"agent.delta","seq":1,"text":"hi"}');
    expect(model.snapshot().messages[0].blocks).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('connects with kind=agent and sends agent.start on ready with lastSeq', async () => {
    const model = new AgentChatModel();
    const f = fakeOpener();
    bindAgentSession({
      model,
      hostId: 'h',
      sessionId: 's1',
      noiseAddress: 'ws://x',
      cwd: '/tmp',
      open: f.open,
    });
    await Promise.resolve();
    expect(f.params()?.kind).toBe('agent');
    // first ready → sinceSeq 0
    f.handlers().onReady?.();
    expect(JSON.parse(f.sent[0])).toEqual({ t: 'agent.start', id: 's1', cwd: '/tmp', sinceSeq: 0 });
    // apply frames, then a reconnect ready → sinceSeq advances
    f.handlers().onMessage('{"t":"agent.delta","seq":7,"text":"x"}');
    f.handlers().onReady?.();
    expect(JSON.parse(f.sent[1]).sinceSeq).toBe(7);
  });
});
