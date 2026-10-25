import Foundation

struct ChatToolCall: Equatable, Sendable {
  var id: String
  var title: String
  var kind: ACPToolKind
  var status: ACPToolStatus
  var diff: ACPDiff?
  var text: String?
  var rawOutput: String?

  init(_ fields: ACPToolFields) {
    id = fields.id
    title = fields.title ?? "Tool"
    kind = fields.kind ?? .other
    status = fields.status ?? .pending
    diff = fields.diff
    text = fields.text
    rawOutput = fields.rawOutput
  }

  mutating func merge(_ fields: ACPToolFields) {
    if let value = fields.title { title = value }
    if let value = fields.kind { kind = value }
    if let value = fields.status { status = value }
    if let value = fields.diff { diff = value }
    if let value = fields.text { text = value }
    if let value = fields.rawOutput { rawOutput = value }
  }
}

struct ChatPermission: Equatable, Sendable {
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

struct ChatItem: Equatable, Identifiable, Sendable {
  enum Kind: Equatable, Sendable {
    case user(text: String, imageCount: Int = 0, offset: Int)
    case assistant(text: String, messageId: String?)
    case thought(text: String)
    case tool(ChatToolCall)
    case permission(ChatPermission)
    case plan([ACPPlanEntry])
    case notice(String)
    case error(String)
  }

  var id: Int
  var kind: Kind
}

struct ChatState: Equatable, Sendable {
  enum Turn: Equatable, Sendable { case idle, working }
  enum Connection: Equatable, Sendable { case live, lost }

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

  func option(id: String) -> ACPConfigOption? { configOptions.first { $0.id == id } }

  /// The human name of the option's current choice, for a chip.
  func currentChoice(of id: String) -> String? {
    guard let option = option(id: id) else { return nil }
    return option.choices.first { $0.value == option.currentValue }?.name ?? option.currentValue
  }

  var pendingPermissions: [ChatPermission] {
    items.compactMap {
      if case let .permission(permission) = $0.kind, permission.resolvedOptionId == nil { return permission }
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
      }
    case let .errorResponse(id, code, text):
      if let id, state.silentRequestIds.contains(id) { return }
      append(.error(text.isEmpty ? "Agent error \(code)" : text), to: &state)
      state.turn = .idle
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
      if case var .tool(call) = state.items[index].kind, call.id == fields.id {
        call.merge(fields)
        state.items[index].kind = .tool(call)
        return
      }
    }
    if creating { append(.tool(ChatToolCall(fields)), to: &state) }
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
