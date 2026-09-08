import Foundation

/// What the chat sends back to the host over the Noise channel.
public enum AgentOutbound: Sendable, Equatable {
  case prompt(String)
  case interrupt
  case permission(reqId: String, decision: String)  // 'allow' | 'deny' | 'allow_always'
}

/// Per-chat state + reducer. Server `agent.*` frames go through `apply`; the
/// view reads `messages` / `turn` / `pendingApproval`. Kept out of the global
/// SessionStore so a chat tab owns its own transcript and stays unit-testable.
@Observable
@MainActor
public final class AgentChatModel {
  public var messages: [AgentMessage] = []
  public var turn: AgentTurnState = .idle
  public var pendingApproval: AgentToolCall?
  public let sessionId: String
  public let cwd: String

  /// Highest frame `seq` this model has applied. Sent back as `sinceSeq` on the
  /// next `agent.start` (reconnect or app relaunch) so the host replays only
  /// what was missed. A brand-new model starts at 0 — a cold client asking for
  /// the full transcript.
  public private(set) var lastSeq: Int = 0

  /// Fired once, with the trimmed text, the first time this chat sends a user
  /// prompt — the hook `SessionStore.newAgentChat` uses to title the tab from
  /// the prompt's gist instead of the cwd basename. Never fires again after.
  public var onFirstPrompt: ((String) -> Void)?

  private let send: (AgentOutbound) -> Void

  public init(sessionId: String, cwd: String, send: @escaping (AgentOutbound) -> Void = { _ in }) {
    self.sessionId = sessionId
    self.cwd = cwd
    self.send = send
  }

  // MARK: outbound

  public func sendPrompt(_ raw: String) {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, turn == .idle else { return }
    let isFirstUserPrompt = !messages.contains { $0.role == .user }
    appendUser(text)
    turn = .thinking
    send(.prompt(text))
    if isFirstUserPrompt {
      onFirstPrompt?(text)
    }
  }

  public func interrupt() { send(.interrupt) }

  public func resolveApproval(_ decision: String) {
    guard let pending = pendingApproval else { return }
    send(.permission(reqId: pending.id.uuidString, decision: decision))
    pendingApproval = nil
    if decision == "deny" { turn = .idle }
  }

  public func appendUser(_ text: String) {
    messages.append(AgentMessage(role: .user, blocks: [.text(id: UUID(), text)]))
  }

  // MARK: reducer

  public func apply(_ msg: NoiseServerMessage) {
    switch msg {
    case let .agentDelta(seq, text):
      noteSeq(seq)
      streamDelta(text)
    case let .agentTool(seq, name, input):
      noteSeq(seq)
      addTool(name: name, inputJSON: input)
    case let .agentToolResult(seq, text, isError):
      noteSeq(seq)
      fillToolResult(text: text, isError: isError)
    case let .agentPermissionReq(reqId, name, input):
      pendingApproval = AgentToolCall(
        id: UUID(uuidString: reqId) ?? UUID(),
        name: name,
        summary: summarize(name: name, inputJSON: input),
        inputJSON: input
      )
    case let .agentDone(seq, _):
      noteSeq(seq)
      if let last = messages.indices.last, messages[last].role == .assistant {
        messages[last].isStreaming = false
      }
      turn = .idle
    case let .agentError(message):
      messages.append(AgentMessage(role: .error, blocks: [.text(id: UUID(), message)]))
      turn = .idle
    default:
      break
    }
  }

  /// Replayed frames arrive in ascending seq order, but this stays a max
  /// (rather than an unconditional overwrite) as a defensive floor.
  private func noteSeq(_ seq: Int) {
    lastSeq = max(lastSeq, seq)
  }

  private func streamDelta(_ text: String) {
    turn = .streaming
    if let last = messages.indices.last, messages[last].role == .assistant,
      messages[last].isStreaming {
      // A tool just ran (last block is `.tool`) → the delta starts a fresh
      // paragraph rather than gluing onto whatever text preceded the tool.
      if case let .text(id, existing)? = messages[last].blocks.last {
        messages[last].blocks[messages[last].blocks.count - 1] = .text(id: id, existing + text)
      } else {
        messages[last].blocks.append(.text(id: UUID(), text))
      }
    } else {
      messages.append(AgentMessage(role: .assistant, blocks: [.text(id: UUID(), text)], isStreaming: true))
    }
  }

  private func addTool(name: String, inputJSON: String) {
    let call = AgentToolCall(
      name: name,
      summary: summarize(name: name, inputJSON: inputJSON),
      inputJSON: inputJSON,
      diff: derivedDiff(name: name, inputJSON: inputJSON)
    )
    messages[ensureAssistantIndex()].blocks.append(.tool(call))
  }

  private func fillToolResult(text: String, isError: Bool) {
    guard let mi = messages.indices.last, messages[mi].role == .assistant else { return }
    guard
      let bi = messages[mi].blocks.lastIndex(where: {
        if case let .tool(call) = $0 { return call.result == nil }
        return false
      })
    else { return }
    guard case var .tool(call) = messages[mi].blocks[bi] else { return }
    call.result = text
    call.isError = isError
    messages[mi].blocks[bi] = .tool(call)
  }

  private func ensureAssistantIndex() -> Int {
    if let last = messages.indices.last, messages[last].role == .assistant { return last }
    messages.append(AgentMessage(role: .assistant, isStreaming: true))
    return messages.count - 1
  }

  private func summarize(name: String, inputJSON: String) -> String {
    let obj = (try? JSONSerialization.jsonObject(with: Data(inputJSON.utf8))) as? [String: Any]
    switch name.lowercased() {
    case "bash", "shell": return (obj?["command"] as? String) ?? name
    case "read", "edit", "write", "multiedit":
      return (obj?["file_path"] as? String) ?? name
    case "grep": return (obj?["pattern"] as? String) ?? name
    case "glob": return (obj?["pattern"] as? String) ?? name
    default: return name
    }
  }

  // Edit/Write with a ready-made patch render as a diff card; otherwise nil.
  private func derivedDiff(name: String, inputJSON: String) -> String? {
    let obj = (try? JSONSerialization.jsonObject(with: Data(inputJSON.utf8))) as? [String: Any]
    return obj?["_diff"] as? String
  }
}
