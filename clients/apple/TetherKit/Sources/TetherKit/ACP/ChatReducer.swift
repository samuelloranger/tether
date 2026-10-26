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
  /// The pictures the result carried; the files live in the chat's image store.
  var images: [ChatImageRef] = []
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
    if let value = fields.images, !value.isEmpty { images = value }
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
    case user(text: String, imageCount: Int = 0, offset: Int, images: [ChatImageRef] = [])
    case assistant(text: String, messageId: String?)
    /// Pictures the agent sent in its message, in order with the text around them.
    case images([ChatImageRef], messageId: String?)
    case thought(text: String)
    case tool(ChatToolCall)
    case permission(ChatPermission)
    case question(ChatQuestion)
    case plan([ACPPlanEntry])
    case notice(String)
    case error(String)
    /// A quiet rule in the transcript, such as where the agent's context was cleared.
    case divider(String)
    /// The agent refused for lack of a login on its host; the view names the host.
    case signedOut
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
  /// User messages sent while an earlier prompt was still running, until the agent starts them.
  fileprivate(set) var queuedItemIds: [Int] = []
  fileprivate var inFlight: [InFlightPrompt] = []
  /// A prompt just ended while others wait: the next agent output or echoed message starts the oldest.
  fileprivate var startPending = false
  fileprivate var nextItemId = 0
  /// Requests whose failure belongs to the caller, not the transcript.
  fileprivate var silentRequestIds: Set<ACPID> = []
  /// Answers the host took while no client was attached, so a replayed request shows resolved.
  fileprivate var hostAnswers: [ACPID: String] = [:]
  /// The question tool's own calls: the question row stands for them.
  fileprivate var questionToolIds: Set<String> = []
  /// The id of the replayed user message the last user row came from, so two messages in a row stay two rows.
  fileprivate var lastUserMessageId: String?

  struct InFlightPrompt: Codable, Equatable, Sendable {
    var itemId: Int
    /// Nil for a prompt journaled before ids were recorded; such a response matches the oldest.
    var requestId: ACPID?
  }

  func isQueued(_ itemId: Int) -> Bool { queuedItemIds.contains(itemId) }

  /// The text of each message waiting for the running turn, oldest first.
  var queuedTexts: [String] {
    queuedItemIds.compactMap { id in
      guard case let .user(text, _, _, _)? = items.first(where: { $0.id == id })?.kind,
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return nil }
      return text
    }
  }

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
  case userPrompt(text: String, imageCount: Int = 0, atOffset: Int, requestId: ACPID? = nil, images: [ChatImageRef] = [])
  /// The user pressed Stop: messages still waiting to start are no longer shown as queued.
  case cancelRequested
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
  case promptUndelivered(text: String, imageCount: Int = 0, atOffset: Int, requestId: ACPID? = nil, images: [ChatImageRef] = [])
  case connectionLost
  case failure(String)
}

enum ChatReducer {
  static func reduce(_ state: ChatState, _ event: ChatEvent) -> ChatState {
    var next = state
    switch event {
    case let .message(message):
      apply(message, to: &next)
    case let .userPrompt(text, imageCount, offset, requestId, images):
      let itemId = next.nextItemId
      append(.user(text: text, imageCount: imageCount, offset: offset, images: images), to: &next)
      if !next.inFlight.isEmpty {
        next.queuedItemIds.append(itemId)
        moveToEnd(itemId, in: &next)
      }
      next.inFlight.append(.init(itemId: itemId, requestId: requestId))
      next.turn = .working
    case .cancelRequested:
      // The agent drops every prompt that has not started, so they leave the transcript; the
      // client that pressed Stop sends their text again as one new prompt.
      let queued = Set(next.queuedItemIds)
      next.queuedItemIds = []
      next.items.removeAll { queued.contains($0.id) }
      next.inFlight.removeAll { queued.contains($0.itemId) }
      next.startPending = false
      if next.turn == .working { append(.notice("Stopped"), to: &next) }
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
    case let .promptUndelivered(text, imageCount, offset, _, images):
      if let index = next.items.lastIndex(where: {
        $0.kind == .user(text: text, imageCount: imageCount, offset: offset, images: images)
      }) {
        let itemId = next.items[index].id
        next.items.remove(at: index)
        next.inFlight.removeAll { $0.itemId == itemId }
        next.queuedItemIds.removeAll { $0 == itemId }
        if next.queuedItemIds.isEmpty { next.startPending = false }
      }
      next.turn = next.inFlight.isEmpty ? .idle : .working
    case .connectionLost:
      next.connection = .lost
    case let .failure(message):
      append(.error(message), to: &next)
      next.connection = .lost
    }
    return next
  }

  /// Queued messages wait at the end of `items` in the order they were sent; everything else goes
  /// in before them, so the running turn keeps streaming into its own rows.
  private static func openEnd(_ state: ChatState) -> Int {
    var end = state.items.count
    while end > 0, state.queuedItemIds.contains(state.items[end - 1].id) { end -= 1 }
    return end
  }

  /// The index of the last item that is not waiting in the queue.
  private static func lastOpen(_ state: ChatState) -> Int? {
    let end = openEnd(state)
    return end > 0 ? end - 1 : nil
  }

  private static func append(_ kind: ChatItem.Kind, to state: inout ChatState) {
    state.items.insert(ChatItem(id: state.nextItemId, kind: kind), at: openEnd(state))
    state.nextItemId += 1
  }

  private static func moveToEnd(_ itemId: Int, in state: inout ChatState) {
    guard let index = state.items.firstIndex(where: { $0.id == itemId }) else { return }
    state.items.append(state.items.remove(at: index))
  }

  /// A queued message that starts joins the transcript below what came before it, ahead of the
  /// messages still waiting.
  private static func unqueue(_ itemId: Int, in state: inout ChatState) {
    state.queuedItemIds.removeAll { $0 == itemId }
    guard let index = state.items.firstIndex(where: { $0.id == itemId }) else { return }
    let item = state.items.remove(at: index)
    state.items.insert(item, at: openEnd(state))
  }

  private static func apply(_ message: ACPInbound, to state: inout ChatState) {
    switch message {
    case let .response(responseId, result):
      if let id = result.sessionId { state.sessionId = id }
      if let load = result.loadSession { state.loadSession = load }
      if let options = result.configOptions { setConfigOptions(options, in: &state) }
      if let reason = result.stopReason {
        let finished = finishPrompt(responseId, in: &state)
        state.lastStopReason = reason
        if let finished { markEnd(of: finished, reason: reason, in: &state) }
        endPendingQuestions(in: &state)
      }
    case let .errorResponse(id, code, text):
      if let id, state.silentRequestIds.contains(id) { return }
      if let id { finishPrompt(id, in: &state) } else { state.turn = state.inFlight.isEmpty ? .idle : .working }
      if ChatAuthError.matches(code: code, message: text) {
        markSignedOut(in: &state)
      } else {
        append(.error(text.isEmpty ? "Agent error \(code)" : text), to: &state)
      }
      endPendingQuestions(in: &state)
    case let .permissionRequest(id, request):
      startQueued(in: &state)
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
      startQueued(in: &state)
      if let toolId = request.toolCallId { state.questionToolIds.insert(toolId) }
      append(
        .question(ChatQuestion(
          requestId: id, toolCallId: request.toolCallId, message: request.message, fields: request.fields)),
        to: &state)
      if let value = state.hostAnswers[id] { resolveQuestion(id, hostValue: value, in: &state) }
    case let .update(update):
      apply(update, to: &state)
    case let .authStatus(signedIn):
      startQueued(in: &state)
      if signedIn {
        state.items.removeAll { $0.kind == .signedOut }
      } else {
        markSignedOut(in: &state)
      }
    // Translated by the transcript builder, which knows which client this is.
    case .clientEcho, .unknown:
      break
    }
  }

  private static func apply(_ update: ACPUpdate, to state: inout ChatState) {
    switch update {
    case let .agentMessage(text, messageId):
      startQueued(in: &state)
      if let last = lastOpen(state),
        case let .assistant(existing, existingId) = state.items[last].kind, existingId == messageId
      {
        state.items[last].kind = .assistant(text: existing + text, messageId: messageId)
      } else {
        append(.assistant(text: text, messageId: messageId), to: &state)
      }
    case let .agentImage(ref, messageId):
      startQueued(in: &state)
      if let last = lastOpen(state),
        case let .images(existing, existingId) = state.items[last].kind, existingId == messageId
      {
        state.items[last].kind = .images(existing + [ref], messageId: messageId)
      } else {
        append(.images([ref], messageId: messageId), to: &state)
      }
    case let .agentThought(text):
      startQueued(in: &state)
      if let last = lastOpen(state), case let .thought(existing) = state.items[last].kind {
        state.items[last].kind = .thought(text: existing + text)
      } else {
        append(.thought(text: text), to: &state)
      }
    case let .userMessage(text, messageId):
      if let first = state.queuedItemIds.first {
        unqueue(first, in: &state)
        state.startPending = false
        if let index = state.items.firstIndex(where: { $0.id == first }),
          case let .user(echoed, _, _, _) = state.items[index].kind, echoed == text
        {
          return
        }
      }
      if let last = lastOpen(state), case let .user(existing, count, offset, refs) = state.items[last].kind,
        messageId == nil || state.lastUserMessageId == nil || messageId == state.lastUserMessageId
      {
        state.items[last].kind = .user(text: existing + text, imageCount: count, offset: offset, images: refs)
      } else {
        append(.user(text: text, offset: 0), to: &state)
      }
      state.lastUserMessageId = messageId
    case let .toolCall(fields), let .toolCallUpdate(fields):
      startQueued(in: &state)
      if fields.toolName == ChatQuestion.toolName { state.questionToolIds.insert(fields.id) }
      if state.questionToolIds.contains(fields.id) { return }
      mergeTool(fields, creating: true, into: &state)
    case let .plan(entries):
      startQueued(in: &state)
      var replaced = false
      for index in state.items.indices.prefix(openEnd(state)).reversed() {
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

  private static func markSignedOut(in state: inout ChatState) {
    if let last = lastOpen(state), case .signedOut = state.items[last].kind { return }
    append(.signedOut, to: &state)
  }

  /// Agent output after a prompt ended is what tells the next waiting message has begun.
  private static func startQueued(in state: inout ChatState) {
    guard state.startPending, let first = state.queuedItemIds.first else { return }
    unqueue(first, in: &state)
    state.startPending = false
  }

  private struct FinishedPrompt {
    var itemId: Int
  }

  /// Takes the prompt a response answers out of the in-flight list; the turn stays working until the last one is answered.
  @discardableResult
  private static func finishPrompt(_ id: ACPID, in state: inout ChatState) -> FinishedPrompt? {
    let index = state.inFlight.firstIndex { $0.requestId == id } ?? state.inFlight.firstIndex { $0.requestId == nil }
    var finished: FinishedPrompt?
    if let index {
      let prompt = state.inFlight.remove(at: index)
      if state.queuedItemIds.contains(prompt.itemId) { unqueue(prompt.itemId, in: &state) }
      finished = FinishedPrompt(itemId: prompt.itemId)
      state.startPending = !state.queuedItemIds.isEmpty
    }
    state.turn = state.inFlight.isEmpty ? .idle : .working
    return finished
  }

  /// `/clear` and `/compact` end silently; a rule marks where the agent's context changed.
  private static func markEnd(of prompt: FinishedPrompt, reason: String, in state: inout ChatState) {
    guard reason == "end_turn", let start = state.items.firstIndex(where: { $0.id == prompt.itemId }),
      case let .user(text, _, _, _) = state.items[start].kind
    else { return }
    let label: String
    switch text.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "/clear": label = "Context cleared"
    case "/compact":
      let announced = state.items[(start + 1)...].contains {
        if case let .assistant(reply, _) = $0.kind { return reply.lowercased().contains("compact") }
        return false
      }
      guard !announced else { return }
      label = "Context compacted"
    default: return
    }
    let later = state.items.indices.first { index in
      index > start && state.inFlight.contains { $0.itemId == state.items[index].id }
    }
    let item = ChatItem(id: state.nextItemId, kind: .divider(label))
    state.nextItemId += 1
    state.items.insert(item, at: later ?? state.items.endIndex)
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
