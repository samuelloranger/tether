import { useRef } from 'react';
import type { TerminalSessionsOptions } from './sessionHostOps';
import {
  buildTransportBag,
  createSessionActions,
  sessionHostMutations,
} from './terminalSessionActions';
import { useTerminalSessionEffects } from './terminalSessionEffects';
import { sessionPublicApi } from './terminalSessionPublic';
import { useTerminalSessionState } from './terminalSessionState';

export function useTerminalSessions(opts: TerminalSessionsOptions) {
  const state = useTerminalSessionState(opts.client);
  const readyRef = useRef(opts.ready);
  readyRef.current = opts.ready;
  const bag = buildTransportBag(opts, state, readyRef);
  const actions = createSessionActions(opts, state, bag);
  state.notifyWaitingSessionsRef.current = (rows) => bag.notifyWaitingSessions(rows);
  state.updateHealthRef.current = actions.updateHealth;
  useTerminalSessionEffects(opts, state, actions);
  return sessionPublicApi(state, actions, sessionHostMutations(opts, state, actions));
}
