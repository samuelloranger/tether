import { AgentModelPicker } from './AgentModelPicker';
import { AgentResumePicker } from './AgentResumePicker';
import type { AgentChatModel, AgentSnapshot } from './agentChatModel';
import { agentModel } from './agentFrames';
import type { ClaudeSessionMeta } from './agentTypes';

/** The `/model` and `/resume` overlays for an agent pane, shown per
 * `snapshot.pendingPicker`. Split out so AgentChatPane stays small. */
export function AgentPanePickers({
  model,
  snapshot,
  send,
  cwd,
  onResumeSession,
}: {
  model: AgentChatModel;
  snapshot: AgentSnapshot;
  send: (payload: unknown) => void;
  cwd?: string;
  onResumeSession?: (session: ClaudeSessionMeta) => void;
}) {
  if (snapshot.pendingPicker === 'model') {
    return (
      <AgentModelPicker
        current={snapshot.status?.model}
        onPick={(name) => {
          send(agentModel(name));
          model.closePicker();
        }}
        onClose={() => model.closePicker()}
      />
    );
  }
  if (snapshot.pendingPicker === 'resume') {
    return (
      <AgentResumePicker
        sessions={snapshot.resumeSessions}
        cwd={cwd}
        onPick={(session) => {
          model.closePicker();
          onResumeSession?.(session);
        }}
        onClose={() => model.closePicker()}
      />
    );
  }
  return null;
}
