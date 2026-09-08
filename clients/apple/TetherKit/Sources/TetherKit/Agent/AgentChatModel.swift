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
    appendUser(text)
    turn = .thinking
    send(.prompt(text))
  }

  public func interrupt() { send(.interrupt) }

  public func resolveApproval(_ decision: String) {
    guard let pending = pendingApproval else { return }
    send(.permission(reqId: pending.id.uuidString, decision: decision))
    pendingApproval = nil
    if decision == "deny" { turn = .idle }
  }

  public func appendUser(_ text: String) {
    messages.append(AgentMessage(role: .user, text: text))
  }

  // MARK: reducer

  public func apply(_ msg: NoiseServerMessage) {
    switch msg {
    case let .agentDelta(_, text): streamDelta(text)
    case let .agentTool(_, name, input): addTool(name: name, inputJSON: input)
    case let .agentToolResult(_, text, isError): fillToolResult(text: text, isError: isError)
    case let .agentPermissionReq(reqId, name, input):
      pendingApproval = AgentToolCall(
        id: UUID(uuidString: reqId) ?? UUID(),
        name: name,
        summary: summarize(name: name, inputJSON: input),
        inputJSON: input
      )
    case .agentDone:
      if let last = messages.indices.last, messages[last].role == .assistant {
        messages[last].isStreaming = false
      }
      turn = .idle
    case let .agentError(message):
      messages.append(AgentMessage(role: .error, text: message))
      turn = .idle
    default:
      break
    }
  }

  private func streamDelta(_ text: String) {
    turn = .streaming
    if let last = messages.indices.last, messages[last].role == .assistant,
      messages[last].isStreaming {
      messages[last].text += text
    } else {
      messages.append(AgentMessage(role: .assistant, text: text, isStreaming: true))
    }
  }

  private func addTool(name: String, inputJSON: String) {
    let call = AgentToolCall(
      name: name,
      summary: summarize(name: name, inputJSON: inputJSON),
      inputJSON: inputJSON,
      diff: derivedDiff(name: name, inputJSON: inputJSON)
    )
    ensureAssistant().tools.append(call)
  }

  private func fillToolResult(text: String, isError: Bool) {
    guard let mi = messages.indices.last, messages[mi].role == .assistant else { return }
    guard let ti = messages[mi].tools.lastIndex(where: { $0.result == nil }) else { return }
    messages[mi].tools[ti].result = text
    messages[mi].tools[ti].isError = isError
  }

  private func ensureAssistant() -> AssistantRef {
    if let last = messages.indices.last, messages[last].role == .assistant {
      return AssistantRef(model: self, index: last)
    }
    messages.append(AgentMessage(role: .assistant, isStreaming: true))
    return AssistantRef(model: self, index: messages.count - 1)
  }

  // Cursor into the trailing assistant message so callers can `.tools.append`.
  fileprivate struct AssistantRef {
    let model: AgentChatModel
    let index: Int
    var tools: [AgentToolCall] {
      get { model.messages[index].tools }
      nonmutating set { model.messages[index].tools = newValue }
    }
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
