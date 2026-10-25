import Foundation

/// A subagent launch, as the adapter's `Agent` tool (older `Task`) describes it.
struct ChatSubagent: Codable, Equatable, Sendable {
  var description: String?
  var model: String?
  var subagentType: String?
  var prompt: String?
  /// Set by `run_in_background` or by the launch result; a background run reports back as assistant text.
  var background = false

  static let launchToolNames: Set<String> = ["Agent", "Task"]
  static let asyncLaunchPrefix = "Async agent launched successfully"

  mutating func merge(_ input: [String: String]) {
    if let value = input["description"] { description = value }
    if let value = input["model"] { model = value }
    if let value = input["subagent_type"] { subagentType = value }
    if let value = input["prompt"] { prompt = value }
    if input["run_in_background"] == "true" { background = true }
  }
}

struct ChatToolCall: Codable, Equatable, Sendable {
  var id: String
  var title: String
  var kind: ACPToolKind
  var status: ACPToolStatus
  var diff: ACPDiff?
  var text: String?
  var rawOutput: String?
  var parentId: String?
  var subagent: ChatSubagent?
  /// A launch row's own tool calls, in arrival order.
  var children: [ChatToolCall] = []

  init(_ fields: ACPToolFields) {
    id = fields.id
    title = fields.title ?? "Tool"
    kind = fields.kind ?? .other
    status = fields.status ?? .pending
    diff = fields.diff
    parentId = fields.parentId
    if let name = fields.toolName, ChatSubagent.launchToolNames.contains(name) { subagent = ChatSubagent() }
    merge(fields)
  }

  mutating func merge(_ fields: ACPToolFields) {
    if let value = fields.title { title = value }
    if let value = fields.kind { kind = value }
    if let value = fields.status { status = value }
    if let value = fields.diff { diff = value }
    if let value = fields.parentId { parentId = value }
    if let value = fields.rawOutput { rawOutput = value }
    if subagent != nil {
      if let input = fields.input { subagent?.merge(input) }
      if let value = fields.text, value.hasPrefix(ChatSubagent.asyncLaunchPrefix) {
        subagent?.background = true
      } else if let value = fields.text {
        text = value
      }
    } else if let value = fields.text {
      text = value
    }
  }

  var isRunning: Bool { status == .pending || status == .inProgress }

  /// Whether the row should show a spinner: its own call, or a background run still making calls.
  var isActive: Bool {
    isRunning || (subagent?.background == true && children.contains { $0.isRunning })
  }

  var subagentTitle: String {
    if let description = subagent?.description, !description.isEmpty { return description }
    return title == "Task" || title == "Agent" ? "Subagent" : title
  }
}

struct ChatPermission: Codable, Equatable, Sendable {
  var requestId: ACPID
  var toolCallId: String
  var title: String
  var kind: ACPToolKind
  var diff: ACPDiff?
  var text: String?
  var options: [ACPPermissionOption]
  /// The option the user picked, or "cancelled"; nil while the agent is still waiting.
  var resolvedOptionId: String?
}

struct ChatItem: Codable, Equatable, Identifiable, Sendable {
  enum Kind: Codable, Equatable, Sendable {
    case user(text: String, imageCount: Int = 0, offset: Int)
    case assistant(text: String, messageId: String?)
    case thought(text: String)
    case tool(ChatToolCall)
    case permission(ChatPermission)
    case question(ChatQuestion)
    case plan([ACPPlanEntry])
    case notice(String)
    case error(String)
  }

  var id: Int
  var kind: Kind
}

struct ChatState: Codable, Equatable, Sendable {
  enum Turn: String, Codable, Equatable, Sendable { case idle, working }
  enum Connection: String, Codable, Equatable, Sendable { case live, lost }

  var items: [ChatItem] = []
  var turn: Turn = .idle
  var connection: Connection = .live
  var sessionId: String?
  var title: String?
  var modeId: String?
  var configOptions: [ACPConfigOption] = []
  var commands: [ACPCommand] = []
  var cost: ChatCost?
  var modelId: String?
  var contextUsed: Int?
  var contextSize: Int?
  var lastStopReason: String?
  var loadSession: Bool?
  fileprivate var nextItemId = 0
  /// Requests whose failure belongs to the caller, not the transcript.
  fileprivate var silentRequestIds: Set<ACPID> = []
  /// Answers the host took while no client was attached, so a replayed request shows resolved.
  fileprivate var hostAnswers: [ACPID: String] = [:]
  /// The question tool's own calls: the question row stands for them.
  fileprivate var questionToolIds: Set<String> = []

  func option(id: String) -> ACPConfigOption? { configOptions.first { $0.id == id } }

  /// The human name of the option's current choice, for a chip.
  func currentChoice(of id: String) -> String? {
    guard let option = option(id: id) else { return nil }
    return option.choices.first { $0.value == option.currentValue }?.name ?? option.currentValue
  }

  /// What a running subagent is doing now, for the working indicator.
  var subagentActivity: String? {
    for item in items.reversed() {
      guard case let .tool(call) = item.kind, call.subagent != nil, call.isActive else { continue }
      guard let latest = call.children.last(where: { $0.isRunning }) ?? call.children.last else {
        return call.subagentTitle
      }
      return "\(call.subagentTitle) \u{00B7} \(latest.title)"
    }
    return nil
  }

  var pendingPermissions: [ChatPermission] {
    items.compactMap {
      if case let .permission(permission) = $0.kind, permission.resolvedOptionId == nil { return permission }
      return nil
    }
  }
}

extension ChatState {
  var pendingQuestions: [ChatQuestion] {
    items.compactMap {
      if case let .question(question) = $0.kind, question.isPending { return question }
      return nil
    }
  }
}

enum ChatEvent: Equatable, Sendable {
  case message(ACPInbound)
  case userPrompt(text: String, imageCount: Int = 0, atOffset: Int)
  /// A request whose error response must not surface as a transcript row.
  case silentRequest(requestId: ACPID)
  case permissionAnswered(requestId: ACPID, optionId: String)
  /// The answer never reached the agent: the card asks again, unless something else resolved it since.
  case permissionAnswerUndelivered(requestId: ACPID, optionId: String)
  /// The host answered this request itself; the card resolves now or when the request arrives.
  case hostAnswered(requestId: ACPID, optionId: String)
  /// The user answered, declined or cancelled a question; `content` is only meaningful for an accept.
  case questionAnswered(requestId: ACPID, action: ChatQuestionAction, content: [String: ChatQuestionValue])
  /// The answer never reached the agent: the question asks again, unless something else resolved it since.
  case questionAnswerUndelivered(requestId: ACPID, action: ChatQuestionAction, content: [String: ChatQuestionValue])
  /// The prompt never reached the agent: drop it from the transcript and end the turn it opened.
  case promptUndelivered(text: String, imageCount: Int = 0, atOffset: Int)
  case connectionLost
  case failure(String)
}

enum ChatReducer {
  static func reduce(_ state: ChatState, _ event: ChatEvent) -> ChatState {
    var next = state
    switch event {
    case let .message(message):
      apply(message, to: &next)
    case let .userPrompt(text, imageCount, offset):
      append(.user(text: text, imageCount: imageCount, offset: offset), to: &next)
      next.turn = .working
    case let .silentRequest(requestId):
      next.silentRequestIds.insert(requestId)
    case let .permissionAnswered(requestId, optionId):
      resolve(requestId, optionId, in: &next)
    case let .permissionAnswerUndelivered(requestId, optionId):
      reopen(requestId, optionId, in: &next)
    case let .questionAnswered(requestId, action, content):
      resolveQuestion(requestId, .init(action: action, content: content), in: &next)
    case let .questionAnswerUndelivered(requestId, action, content):
      reopenQuestion(requestId, .init(action: action, content: content), in: &next)
    case let .hostAnswered(requestId, optionId):
      next.hostAnswers[requestId] = optionId
      resolve(requestId, optionId, in: &next)
      resolveQuestion(requestId, hostValue: optionId, in: &next)
    case let .promptUndelivered(text, imageCount, offset):
      if let index = next.items.lastIndex(where: { $0.kind == .user(text: text, imageCount: imageCount, offset: offset) }) {
        next.items.remove(at: index)
      }
      next.turn = .idle
    case .connectionLost:
      next.connection = .lost
    case let .failure(message):
      append(.error(message), to: &next)
      next.connection = .lost
    }
    return next
  }

  private static func append(_ kind: ChatItem.Kind, to state: inout ChatState) {
    state.items.append(ChatItem(id: state.nextItemId, kind: kind))
    state.nextItemId += 1
  }

  private static func apply(_ message: ACPInbound, to state: inout ChatState) {
    switch message {
    case let .response(_, result):
      if let id = result.sessionId { state.sessionId = id }
      if let load = result.loadSession { state.loadSession = load }
      if let options = result.configOptions { setConfigOptions(options, in: &state) }
      if let reason = result.stopReason {
        state.turn = .idle
        state.lastStopReason = reason
        endPendingQuestions(in: &state)
      }
    case let .errorResponse(id, code, text):
      if let id, state.silentRequestIds.contains(id) { return }
      append(.error(text.isEmpty ? "Agent error \(code)" : text), to: &state)
      state.turn = .idle
      endPendingQuestions(in: &state)
    case let .permissionRequest(id, request):
      mergeTool(request.tool, creating: false, into: &state)
      append(
        .permission(ChatPermission(
          requestId: id,
          toolCallId: request.tool.id,
          title: request.tool.title ?? "Permission requested",
          kind: request.tool.kind ?? .other,
          diff: request.tool.diff,
          text: request.tool.text,
          options: request.options,
          resolvedOptionId: nil)),
        to: &state)
      if let optionId = state.hostAnswers[id] { resolve(id, optionId, in: &state) }
    case let .elicitation(id, request):
      if let toolId = request.toolCallId { state.questionToolIds.insert(toolId) }
      append(
        .question(ChatQuestion(
          requestId: id, toolCallId: request.toolCallId, message: request.message, fields: request.fields)),
        to: &state)
      if let value = state.hostAnswers[id] { resolveQuestion(id, hostValue: value, in: &state) }
    case let .update(update):
      apply(update, to: &state)
    case .unknown:
      break
    }
  }

  private static func apply(_ update: ACPUpdate, to state: inout ChatState) {
    switch update {
    case let .agentMessage(text, messageId):
      if let last = state.items.indices.last,
        case let .assistant(existing, existingId) = state.items[last].kind, existingId == messageId
      {
        state.items[last].kind = .assistant(text: existing + text, messageId: messageId)
      } else {
        append(.assistant(text: text, messageId: messageId), to: &state)
      }
    case let .agentThought(text):
      if let last = state.items.indices.last, case let .thought(existing) = state.items[last].kind {
        state.items[last].kind = .thought(text: existing + text)
      } else {
        append(.thought(text: text), to: &state)
      }
    case let .userMessage(text):
      if let last = state.items.indices.last, case let .user(existing, images, offset) = state.items[last].kind {
        state.items[last].kind = .user(text: existing + text, imageCount: images, offset: offset)
      } else {
        append(.user(text: text, offset: 0), to: &state)
      }
    case let .toolCall(fields), let .toolCallUpdate(fields):
      if fields.toolName == ChatQuestion.toolName { state.questionToolIds.insert(fields.id) }
      if state.questionToolIds.contains(fields.id) { return }
      mergeTool(fields, creating: true, into: &state)
    case let .plan(entries):
      var replaced = false
      for index in state.items.indices.reversed() {
        if case .user = state.items[index].kind { break }
        if case .plan = state.items[index].kind {
          state.items[index].kind = .plan(entries)
          replaced = true
          break
        }
      }
      if !replaced { append(.plan(entries), to: &state) }
    case let .currentMode(mode):
      state.modeId = mode
      if let index = state.configOptions.firstIndex(where: { $0.id == "mode" }) {
        state.configOptions[index].currentValue = mode
      }
    case let .configOptions(options):
      setConfigOptions(options, in: &state)
    case let .commands(commands):
      state.commands = commands
    case let .sessionInfo(title):
      if let title { state.title = title }
    case let .usage(used, size, cost, modelId):
      state.contextUsed = used
      state.contextSize = size
      if let cost { state.cost = cost }
      if let modelId { state.modelId = modelId }
    case .unknown:
      break
    }
  }

  private static func setConfigOptions(_ options: [ACPConfigOption], in state: inout ChatState) {
    state.configOptions = options
    if let mode = options.first(where: { $0.id == "mode" }) { state.modeId = mode.currentValue }
  }

  private static func mergeTool(_ fields: ACPToolFields, creating: Bool, into state: inout ChatState) {
    for index in state.items.indices.reversed() {
      guard case var .tool(call) = state.items[index].kind else { continue }
      if call.id == fields.id {
        call.merge(fields)
        state.items[index].kind = .tool(call)
        return
      }
      if let child = call.children.firstIndex(where: { $0.id == fields.id }) {
        call.children[child].merge(fields)
        state.items[index].kind = .tool(call)
        return
      }
    }
    guard creating else { return }
    if let parentId = fields.parentId, let index = launchIndex(for: parentId, in: state),
      case var .tool(call) = state.items[index].kind
    {
      call.children.append(ChatToolCall(fields))
      state.items[index].kind = .tool(call)
      return
    }
    append(.tool(ChatToolCall(fields)), to: &state)
  }

  /// The top-level row a child belongs under; a subagent launched by a subagent shares its parent's list.
  private static func launchIndex(for parentId: String, in state: ChatState) -> Int? {
    state.items.indices.reversed().first { index in
      guard case let .tool(call) = state.items[index].kind else { return false }
      return call.id == parentId || call.children.contains { $0.id == parentId }
    }
  }

  private static func setQuestion(_ requestId: ACPID, in state: inout ChatState, _ change: (inout ChatQuestion) -> Bool) {
    for index in state.items.indices.reversed() {
      if case var .question(question) = state.items[index].kind, question.requestId == requestId {
        guard change(&question) else { return }
        state.items[index].kind = .question(question)
        return
      }
    }
  }

  private static func resolveQuestion(_ requestId: ACPID, _ resolution: ChatQuestion.State, in state: inout ChatState) {
    setQuestion(requestId, in: &state) { question in
      guard question.isPending else { return false }
      question.state = resolution
      return true
    }
  }

  private static func resolveQuestion(_ requestId: ACPID, hostValue: String, in state: inout ChatState) {
    setQuestion(requestId, in: &state) { question in
      guard question.isPending else { return false }
      question.state = question.hostState(hostValue)
      return true
    }
  }

  private static func reopenQuestion(_ requestId: ACPID, _ resolution: ChatQuestion.State, in state: inout ChatState) {
    setQuestion(requestId, in: &state) { question in
      guard question.state == resolution else { return false }
      question.state = .pending
      return true
    }
  }

  /// A finished turn leaves nothing to answer: the agent has stopped waiting, as the holder sees it.
  private static func endPendingQuestions(in state: inout ChatState) {
    for index in state.items.indices {
      if case var .question(question) = state.items[index].kind, question.isPending {
        question.state = .cancelled
        state.items[index].kind = .question(question)
      }
    }
  }

  private static func reopen(_ requestId: ACPID, _ optionId: String, in state: inout ChatState) {
    for index in state.items.indices.reversed() {
      if case var .permission(permission) = state.items[index].kind,
        permission.requestId == requestId, permission.resolvedOptionId == optionId
      {
        permission.resolvedOptionId = nil
        state.items[index].kind = .permission(permission)
        return
      }
    }
  }

  private static func resolve(_ requestId: ACPID, _ optionId: String, in state: inout ChatState) {
    for index in state.items.indices.reversed() {
      if case var .permission(permission) = state.items[index].kind,
        permission.requestId == requestId, permission.resolvedOptionId == nil
      {
        permission.resolvedOptionId = optionId
        state.items[index].kind = .permission(permission)
        return
      }
    }
  }
}
