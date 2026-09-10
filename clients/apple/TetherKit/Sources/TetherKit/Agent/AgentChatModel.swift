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
  /// Approvals that arrived while one was already on screen — shown one at a time
  /// so a second tool's request can't clobber the first (which would then never
  /// be answered and hang the agent).
  private var approvalBacklog: [AgentToolCall] = []
  /// True between tapping stop and the server confirming the turn ended, so the
  /// composer can show the interrupt is in flight instead of looking inert.
  public private(set) var interrupting = false
  /// Composer text, held on the per-session model (not the view's `@State`) so an
  /// unsent draft survives switching to another tab and back.
  public var draft: String = ""
  /// Prompts typed while a turn was running, fired one per turn as the agent
  /// goes idle. The composer can always send; a busy agent just defers it.
  public private(set) var queued: [String] = []
  public let sessionId: String
  public let cwd: String
  /// Fired once, on the first user prompt this model ever sends (immediate or
  /// queued) — lets `SessionStore` rename the drawer tab from a gist of it.
  public var onFirstPrompt: ((String) -> Void)?

  /// Highest frame `seq` this model has applied. Sent back as `sinceSeq` on the
  /// next `agent.start` (reconnect or app relaunch) so the host replays only
  /// what was missed. A brand-new model starts at 0 — a cold client asking for
  /// the full transcript.
  public private(set) var lastSeq: Int = 0

  /// Bumped on every change to transcript *content* (a new message, a streamed
  /// delta, a tool card, a result). The view watches this to follow the foot as
  /// the agent talks — and, critically, NOT on keyboard frame changes or draft
  /// edits, which must never move the scroll.
  public private(set) var revision: Int = 0

  /// Model + account 5h/7d usage for the composer's info strip. nil until an
  /// `agent.status` frame arrives (server support pending); the strip shows only
  /// the fields it has and hides the rest. Merge via `applyStatus`.
  public private(set) var status: AgentStatus?

  /// This chat's running token/cost total — the sum of every finished turn's
  /// usage. nil while nothing has reported, so the strip omits it.
  public var sessionUsage: AgentUsage? {
    var input = 0
    var output = 0
    var cost = 0.0
    for message in messages {
      guard let usage = message.usage else { continue }
      input += usage.inputTokens
      output += usage.outputTokens
      cost += usage.cost
    }
    let total = AgentUsage(cost: cost, inputTokens: input, outputTokens: output)
    return total.isEmpty ? nil : total
  }

  /// The most recent user prompt, kept so a failed turn can be retried without
  /// the user retyping it — see `retryLast`.
  private var lastUserPrompt: String?

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
    interrupting = false
    lastUserPrompt = text
    appendUser(text)
    turn = .thinking
    send(.prompt(text))
    if isFirstUserPrompt { onFirstPrompt?(text) }
  }

  /// Whether a failed turn can be retried (there is a remembered prompt and the
  /// agent is not mid-turn). Drives the error row's Retry button.
  public var canRetry: Bool { turn == .idle && lastUserPrompt != nil }

  /// Resends the last user prompt after an error, dropping the error row so the
  /// transcript doesn't accumulate a dead end above the retried turn.
  public func retryLast() {
    guard turn == .idle, let text = lastUserPrompt else { return }
    if let last = messages.indices.last, messages[last].role == .error {
      messages.remove(at: last)
    }
    interrupting = false
    turn = .thinking
    send(.prompt(text))
    revision += 1
  }

  /// Sends immediately when idle, otherwise queues to fire when the running
  /// turn ends — see `flushQueue`.
  public func submit(_ raw: String) {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if turn == .idle {
      sendPrompt(text)
    } else {
      queued.append(text)
      revision += 1
    }
  }

  public func cancelQueued(at index: Int) {
    guard queued.indices.contains(index) else { return }
    queued.remove(at: index)
  }

  /// Fires the oldest queued prompt once the agent is idle. One per turn: the
  /// next flushes when this turn's `agentDone` lands.
  private func flushQueue() {
    guard turn == .idle, !queued.isEmpty else { return }
    sendPrompt(queued.removeFirst())
  }

  public func interrupt() {
    guard turn != .idle else { return }
    interrupting = true
    send(.interrupt)
  }

  public func resolveApproval(_ decision: String) {
    guard let pending = pendingApproval else { return }
    send(.permission(reqId: pending.id.uuidString, decision: decision))
    if approvalBacklog.isEmpty {
      pendingApproval = nil
      if decision == "deny" {
        turn = .idle
        flushQueue()
      }
    } else {
      // Another tool is still waiting — show it rather than idling the turn.
      pendingApproval = approvalBacklog.removeFirst()
    }
  }

  public func appendUser(_ text: String) {
    messages.append(AgentMessage(role: .user, blocks: [.text(id: UUID(), text)]))
    revision += 1
  }

  /// Merge a status update from the host. A later frame that carries only some
  /// fields (a fresh model but no new usage, or vice versa) keeps the rest —
  /// so the strip never blanks a value it already showed. This is the entry the
  /// `agent.status` frame handler will call once that frame is wired.
  public func applyStatus(
    model: String? = nil, fiveHour: UsageWindow? = nil, sevenDay: UsageWindow? = nil
  ) {
    let prev = status
    status = AgentStatus(
      model: model ?? prev?.model,
      fiveHour: fiveHour ?? prev?.fiveHour,
      sevenDay: sevenDay ?? prev?.sevenDay)
  }

  // MARK: reducer

  public func apply(_ msg: NoiseServerMessage) {
    // permission_req + status carry no seq; every other agent frame is seq-ordered
    // and must be deduped (replay, reconnect, or double-send must not double-apply).
    var seq: Int?
    switch msg {
    case let .agentDelta(s, _): seq = s
    case let .agentTool(s, _, _): seq = s
    case let .agentToolResult(s, _, _): seq = s
    case let .agentDone(s, _, _, _): seq = s
    case let .agentUser(s, _): seq = s
    default: break
    }
    if let seq {
      guard seq > lastSeq else { return }
      noteSeq(seq)
    }
    switch msg {
    case let .agentDelta(_, text):
      streamDelta(text)
    case let .agentTool(_, name, input):
      addTool(name: name, inputJSON: input)
    case let .agentToolResult(_, text, isError):
      fillToolResult(text: text, isError: isError)
    case let .agentPermissionReq(reqId, name, input):
      let call = AgentToolCall(
        id: UUID(uuidString: reqId) ?? UUID(),
        name: name,
        summary: summarize(name: name, inputJSON: input),
        inputJSON: input
      )
      if pendingApproval == nil {
        pendingApproval = call
      } else {
        approvalBacklog.append(call)
      }
    case let .agentDone(_, cost, inputTokens, outputTokens):
      if let last = messages.indices.last, messages[last].role == .assistant {
        messages[last].isStreaming = false
        messages[last].usage = AgentUsage(
          cost: cost, inputTokens: inputTokens, outputTokens: outputTokens)
      }
      turn = .idle
      interrupting = false
      revision += 1
      flushQueue()
    case let .agentError(message):
      // Close out a half-streamed turn too, or its caret blinks forever behind
      // the error.
      if let last = messages.indices.last, messages[last].role == .assistant {
        messages[last].isStreaming = false
      }
      messages.append(AgentMessage(role: .error, blocks: [.text(id: UUID(), message)]))
      turn = .idle
      interrupting = false
      revision += 1
      flushQueue()
    case let .agentUser(_, text):
      // Render server-authoritative prompts so a conversation started on another
      // device appears here. When the prompt originated locally we already
      // showed it immediately (sendPrompt), so treat this as an ack and avoid a
      // duplicate bubble.
      lastUserPrompt = text
      if messages.last?.role != .user || messages.last?.plainText != text {
        appendUser(text)
      }
      turn = .thinking
      interrupting = false
    case let .agentStatus(model, fiveHour, sevenDay):
      applyStatus(model: model, fiveHour: fiveHour, sevenDay: sevenDay)
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
    revision += 1
  }

  private func addTool(name: String, inputJSON: String) {
    let call = AgentToolCall(
      name: name,
      summary: summarize(name: name, inputJSON: inputJSON),
      inputJSON: inputJSON,
      diff: derivedDiff(name: name, inputJSON: inputJSON)
    )
    messages[ensureAssistantIndex()].blocks.append(.tool(call))
    revision += 1
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
    revision += 1
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

  // A ready-made patch wins; otherwise synthesize one from an Edit/Write's
  // before/after strings so the card shows a diff instead of raw JSON.
  private func derivedDiff(name: String, inputJSON: String) -> String? {
    let obj = (try? JSONSerialization.jsonObject(with: Data(inputJSON.utf8))) as? [String: Any]
    if let pre = obj?["_diff"] as? String, !pre.isEmpty { return pre }
    switch name.lowercased() {
    case "edit":
      guard let old = obj?["old_string"] as? String, let new = obj?["new_string"] as? String
      else { return nil }
      let diff = unifiedLineDiff(old: old, new: new)
      return diff.isEmpty ? nil : diff
    case "write":
      guard let content = obj?["content"] as? String else { return nil }
      let diff = unifiedLineDiff(old: "", new: content)
      return diff.isEmpty ? nil : diff
    case "multiedit":
      guard let edits = obj?["edits"] as? [[String: Any]] else { return nil }
      let parts = edits.compactMap { edit -> String? in
        guard let old = edit["old_string"] as? String, let new = edit["new_string"] as? String
        else { return nil }
        let diff = unifiedLineDiff(old: old, new: new)
        return diff.isEmpty ? nil : diff
      }
      return parts.isEmpty ? nil : parts.joined(separator: "\n")
    default:
      return nil
    }
  }
}
