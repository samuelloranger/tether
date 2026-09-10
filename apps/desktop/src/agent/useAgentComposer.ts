import type { KeyboardEvent } from 'react';
import type { AgentChatModel, AgentSnapshot } from './agentChatModel';
import { type AgentCommand, dispatchDraft, matchCommands } from './agentCommands';
import { agentPermission, agentPrompt } from './agentFrames';
import { transcriptText } from './transcriptText';

/** All composer command logic: the palette match set plus the key/run
 * handlers. Kept out of the component so the JSX stays small and this stays
 * unit-testable without React. */
export function useAgentComposer(
  model: AgentChatModel,
  snapshot: AgentSnapshot,
  send: (payload: unknown) => void,
) {
  const { draft, turn } = snapshot;
  const streaming = turn !== 'idle';
  const matches = matchCommands(draft);
  const paletteOpen = matches.length > 0;
  const highlighted = paletteOpen
    ? matches[Math.min(snapshot.paletteIndex, matches.length - 1)]
    : null;

  const sendPrompt = (text: string) => {
    if (streaming) model.enqueue(text);
    else {
      model.notePromptSent();
      send(agentPrompt(text));
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    sendPrompt(text);
    model.setDraft('');
  };

  const runLocal = (id: string, args: string) => {
    model.setDraft('');
    if (id === 'clear') model.clearTranscript();
    else if (id === 'retry') {
      const t = model.retryLast();
      if (t) send(agentPrompt(t));
    } else if (id === 'copy')
      void navigator.clipboard.writeText(transcriptText(snapshot.messages, args));
    else if (id === 'model') model.openPicker('model');
    else if (id === 'resume') model.openPicker('resume');
  };

  const runCommand = (cmd: AgentCommand) => {
    if (cmd.kind === 'local') return runLocal(cmd.id, '');
    sendPrompt(cmd.trigger);
    model.setDraft('');
  };

  const runDraft = () => {
    const r = dispatchDraft(draft);
    if (r.type === 'local') return runLocal(r.id, r.args);
    if (r.type === 'agentText') {
      sendPrompt(r.text);
      return model.setDraft('');
    }
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteOpen && highlighted) {
      if (e.key === 'ArrowDown') return prevent(e, () => model.movePalette(1));
      if (e.key === 'ArrowUp') return prevent(e, () => model.movePalette(-1));
      if (e.key === 'Tab') return prevent(e, () => model.setDraft(highlighted.trigger));
      if (e.key === 'Escape') return prevent(e, () => model.setDraft(''));
      if (e.key === 'Enter' && !e.shiftKey) return prevent(e, () => runCommand(highlighted));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) prevent(e, runDraft);
  };

  const resolve = (allow: boolean) => {
    const r = model.resolvePermission(allow);
    if (r) send(agentPermission({ reqId: r.id, allow }));
  };

  return { matches, paletteOpen, submit, runCommand, onKeyDown, resolve };
}

function prevent(e: KeyboardEvent<HTMLTextAreaElement>, fn: () => void): void {
  e.preventDefault();
  fn();
}
