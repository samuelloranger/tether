import Foundation

enum ACPClientError: Error, Equatable {
  case connectionLost
  case noSession
  case agent(code: Int, message: String)
}

/// Drives one ACP stream. On a resume the holder replays its whole log, and that replay flows
/// through the same read loop as live traffic; only responses to requests this client is waiting
/// on complete anything, so replayed old responses just feed the transcript.
actor ACPClient {
  private struct Pending {
    var continuation: CheckedContinuation<ACPResult, Error>?
  }

  private let stream: any TerminalByteStream
  private let store: any ChatJournalStore
  private var journal: ChatJournal
  private var builder: ChatTranscriptBuilder
  private var pending: [ACPID: Pending] = [:]
  private var readTask: Task<Void, Never>?
  private var ended = false
  private var subscribers: [UUID: AsyncStream<ChatState>.Continuation] = [:]
  private let snapshotStore: (any ChatSnapshotStore)?
  private let images: ChatImageStore?
  private var snapshotIdentity: Int?
  private let snapshotInterval: Duration
  private var lastSnapshot: ContinuousClock.Instant?
  private var wasWorking = false
  private var feedFailed = false
  /// Joined a chat another client started: the session id comes from the log.
  private var joining = false

  /// `resume` must already be checked against the journal with `ChatSnapshot.isConsistent`; the
  /// stream is then expected to start at its offset.
  init(
    stream: any TerminalByteStream, store: any ChatJournalStore = InMemoryChatJournalStore(),
    resume: ChatSnapshot? = nil, snapshots: (any ChatSnapshotStore)? = nil, snapshotInterval: Duration = .seconds(3),
    images: ChatImageStore? = nil
  ) {
    self.images = images
    self.stream = stream
    self.store = store
    self.snapshotStore = snapshots
    self.snapshotIdentity = resume?.identity
    self.snapshotInterval = snapshotInterval
    let journal = store.load()
    self.journal = journal
    if let resume {
      self.builder = ChatTranscriptBuilder(journal: journal, resuming: resume, images: images)
    } else {
      self.builder = ChatTranscriptBuilder(journal: journal, images: images)
    }
  }

  var state: ChatState { builder.state }
  var sessionId: String? { journal.sessionId }
  /// Bytes taken from the stream so far.
  var receivedBytes: Int { builder.receivedBytes }
  /// True when the agent's output could not be decoded; a resumed client then replays from zero.
  var failedDecoding: Bool { feedFailed }

  /// Current snapshot first, then one per change.
  func updates() -> AsyncStream<ChatState> {
    let id = UUID()
    let (stream, continuation) = AsyncStream.makeStream(of: ChatState.self, bufferingPolicy: .bufferingNewest(1))
    continuation.yield(builder.state)
    subscribers[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeSubscriber(id) }
    }
    return stream
  }

  private func removeSubscriber(_ id: UUID) { subscribers[id] = nil }

  /// Starts reading. With a persisted session id the handshake is skipped entirely; otherwise
  /// runs `initialize` and `session/new`, or `session/load` when continuing an earlier conversation.
  func start(cwd: String, loadSessionId: String? = nil) async throws {
    startReading()
    if journal.sessionId == nil {
      _ = try await initialize()
      if let id = loadSessionId ?? journal.loadedSessionId {
        _ = try await loadSession(id, cwd: cwd)
      } else {
        _ = try await newSession(cwd: cwd)
      }
    }
  }

  func startReading() {
    guard readTask == nil else { return }
    readTask = Task { await self.readLoop() }
  }

  /// For a chat another client started on a holder that takes several: no handshake of its own,
  /// the session comes from the other client's `session/new` answer or prompts in the log.
  func startJoining() {
    joining = true
    startReading()
  }

  func initialize() async throws -> ACPResult {
    try await request(
      "initialize",
      [
        "protocolVersion": 1,
        "clientCapabilities": [
          "fs": ["readTextFile": false, "writeTextFile": false], "terminal": false,
          // Without this the adapter leaves AskUserQuestion out; a chat started before it has none until recreated.
          "elicitation": ["form": [String: Any]()],
        ],
      ])
  }

  @discardableResult
  func newSession(cwd: String) async throws -> String {
    let result = try await request("session/new", ["cwd": cwd, "mcpServers": [Any]()])
    guard let id = result.sessionId else { throw ACPClientError.noSession }
    journal.sessionId = id
    store.save(journal)
    return id
  }

  /// The agent replays the conversation as `session/update` notifications before it answers, so
  /// the history arrives through the same read loop as live output.
  @discardableResult
  func loadSession(_ id: String, cwd: String) async throws -> String {
    journal.loadedSessionId = id
    store.save(journal)
    let result = try await request("session/load", ["sessionId": id, "cwd": cwd, "mcpServers": [Any]()])
    let loaded = result.sessionId ?? id
    journal.sessionId = loaded
    store.save(journal)
    return loaded
  }

  func prompt(text: String, images: [ChatImageAttachment] = []) async throws {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    guard !ended else { throw ACPClientError.connectionLost }
    let offset = builder.consumedOffset
    let count = images.count
    let refs = images.compactMap { self.images?.put($0) }
    let requestId = allocateId()
    journal.entries.append(
      .init(kind: .prompt, offset: offset, text: text, requestId: requestId, imageCount: count, images: refs))
    builder.apply(.userPrompt(text: text, imageCount: count, atOffset: offset, requestId: requestId, images: refs))
    publish()
    store.save(journal)
    var blocks: [[String: Any]] = images.map { ["type": "image", "mimeType": $0.mimeType, "data": $0.data] }
    if !text.isEmpty { blocks.append(["type": "text", "text": text]) }
    do {
      try await send(method: "session/prompt", id: requestId, params: ["sessionId": sessionId, "prompt": blocks])
    } catch {
      if let index = journal.entries.lastIndex(where: {
        $0.kind == .prompt && $0.requestId == requestId
      }) {
        journal.entries.remove(at: index)
      }
      store.save(journal)
      builder.apply(.promptUndelivered(text: text, imageCount: count, atOffset: offset, requestId: requestId, images: refs))
      publish()
      throw error
    }
  }

  /// Returns once the agent confirmed; the new value reaches `state` through the result's options.
  func setConfigOption(id: String, value: String) async throws {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    guard !ended else { throw ACPClientError.connectionLost }
    _ = try await request(
      "session/set_config_option", ["sessionId": sessionId, "configId": id, "value": value], silent: true)
  }

  /// Returns what was waiting when the cancel landed, read in the same step that withdraws it,
  /// for the caller to send again. Only a cancel that never reached the agent throws: an answer
  /// to a pending card that fails afterwards reopens that card instead.
  @discardableResult
  func cancel() async throws -> (text: String, images: Int) {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    try await write(["jsonrpc": "2.0", "method": "session/cancel", "params": ["sessionId": sessionId]])
    let waiting = builder.state.queuedResend
    journal.entries.append(.init(kind: .cancel, offset: builder.consumedOffset))
    builder.apply(.cancelRequested)
    publish()
    store.save(journal)
    for permission in builder.state.pendingPermissions {
      try? await respond(to: permission.requestId, outcome: ["outcome": "cancelled"], optionId: "cancelled")
    }
    for question in builder.state.pendingQuestions {
      try? await answerQuestion(requestId: question.requestId, action: .cancel)
    }
    return waiting
  }

  /// Journaled and shown before the write, and taken back if it fails, like a permission answer.
  /// `content` is only sent with an accept.
  func answerQuestion(
    requestId: ACPID, action: ChatQuestionAction, content: [String: ChatQuestionValue] = [:]
  ) async throws {
    guard builder.state.pendingQuestions.contains(where: { $0.requestId == requestId }) else { return }
    let sent = action == .accept ? content : [:]
    journal.entries.append(
      .init(kind: .questionAnswer, offset: builder.consumedOffset, requestId: requestId, optionId: action.rawValue,
        content: action == .accept ? sent : nil))
    builder.apply(.questionAnswered(requestId: requestId, action: action, content: sent))
    publish()
    store.save(journal)
    var result: [String: Any] = ["action": action.rawValue]
    if action == .accept { result["content"] = sent.mapValues(\.json) }
    do {
      try await write(["jsonrpc": "2.0", "id": requestId.json, "result": result])
    } catch {
      if let index = journal.entries.lastIndex(where: {
        $0.kind == .questionAnswer && $0.requestId == requestId && $0.optionId == action.rawValue
      }) {
        journal.entries.remove(at: index)
      }
      store.save(journal)
      builder.apply(.questionAnswerUndelivered(requestId: requestId, action: action, content: sent))
      publish()
      throw error
    }
  }

  func answerPermission(requestId: ACPID, optionId: String) async throws {
    guard builder.state.pendingPermissions.contains(where: { $0.requestId == requestId }) else { return }
    try await respond(
      to: requestId, outcome: ["outcome": "selected", "optionId": optionId], optionId: optionId)
  }

  /// Answers the host recorded for requests this client never answered. The journal keeps them
  /// so a replay from zero resolves the same cards.
  func adoptHostAnswers(_ answers: [ACPID: String]) {
    let known = journal.answeredRequestIds
    let fresh = answers.filter { !known.contains($0.key) }.sorted { "\($0.key)" < "\($1.key)" }
    guard !fresh.isEmpty else { return }
    for (id, optionId) in fresh {
      journal.entries.append(.init(kind: .hostAnswer, offset: 0, requestId: id, optionId: optionId))
      builder.apply(.hostAnswered(requestId: id, optionId: optionId))
    }
    store.save(journal)
    publish()
  }

  /// Snapshots are only written once the host session's identity is known.
  func setSnapshotIdentity(_ identity: Int) { snapshotIdentity = identity }

  /// Writes the resume snapshot now. A state that lost its connection or failed is never saved:
  /// it holds events the log does not.
  func saveSnapshot() {
    guard let snapshotStore, let snapshotIdentity, builder.state.connection == .live, !feedFailed else { return }
    let consumed = builder.consumedOffset
    guard consumed > 0 else { return }
    lastSnapshot = .now
    snapshotStore.save(
      ChatSnapshot(identity: snapshotIdentity, offset: consumed, journal: journal, state: builder.state))
  }

  private func snapshotIfDue() {
    let working = builder.state.turn == .working
    let turnEnded = wasWorking && !working
    wasWorking = working
    if turnEnded || lastSnapshot.map({ ContinuousClock.now - $0 >= snapshotInterval }) ?? true { saveSnapshot() }
  }

  func stop() async {
    if !ended { saveSnapshot() }
    readTask?.cancel()
    await stream.close()
  }

  /// The answer is journaled and shown before the write so a replay resolves the card, and taken
  /// back if the write fails: a card the agent never heard from must ask again.
  private func respond(to id: ACPID, outcome: [String: Any], optionId: String) async throws {
    journal.entries.append(.init(kind: .answer, offset: builder.consumedOffset, requestId: id, optionId: optionId))
    builder.apply(.permissionAnswered(requestId: id, optionId: optionId))
    publish()
    store.save(journal)
    do {
      try await write(["jsonrpc": "2.0", "id": id.json, "result": ["outcome": outcome]])
    } catch {
      if let index = journal.entries.lastIndex(where: {
        $0.kind == .answer && $0.requestId == id && $0.optionId == optionId
      }) {
        journal.entries.remove(at: index)
      }
      store.save(journal)
      builder.apply(.permissionAnswerUndelivered(requestId: id, optionId: optionId))
      publish()
      throw error
    }
  }

  /// A client named to a holder that takes several prefixes its ids with its name, so two clients
  /// writing to one agent never send the same id.
  private func allocateId() -> ACPID {
    let number = journal.nextRequestId
    let id = journal.clientId.map { ACPID.string("\($0)-\(number)") } ?? .int(number)
    journal.nextRequestId += 1
    store.save(journal)
    return id
  }

  private func request(_ method: String, _ params: [String: Any], silent: Bool = false) async throws -> ACPResult {
    let id = allocateId()
    if silent {
      journal.entries.append(.init(kind: .silentRequest, offset: builder.consumedOffset, requestId: id))
      builder.apply(.silentRequest(requestId: id))
      store.save(journal)
    }
    let data = try encode(["jsonrpc": "2.0", "id": id.json, "method": method, "params": params])
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ACPResult, Error>) in
      if ended {
        continuation.resume(throwing: ACPClientError.connectionLost)
        return
      }
      pending[id] = Pending(continuation: continuation)
      Task {
        do { try await self.stream.write(data) } catch { self.failPending(id, error) }
      }
    }
  }

  private func failPending(_ id: ACPID, _ error: Error) {
    pending.removeValue(forKey: id)?.continuation?.resume(throwing: error)
  }

  private func send(method: String, id: ACPID, params: [String: Any]) async throws {
    pending[id] = Pending(continuation: nil)
    do {
      try await write(["jsonrpc": "2.0", "id": id.json, "method": method, "params": params])
    } catch {
      pending[id] = nil
      throw error
    }
  }

  private func encode(_ message: [String: Any]) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys, .withoutEscapingSlashes])
    data.append(0x0A)
    return data
  }

  private func write(_ message: [String: Any]) async throws {
    try await stream.write(try encode(message))
  }

  private func publish() {
    for continuation in subscribers.values { continuation.yield(builder.state) }
  }

  private func readLoop() async {
    do {
      while let data = try await stream.read() {
        do {
          route(try builder.feed(data))
        } catch {
          feedFailed = true
          builder.apply(.failure("Agent output was not valid: \(error)"))
          finishLoop()
          await stream.close()
          return
        }
        publish()
        snapshotIfDue()
      }
    } catch {}
    saveSnapshot()
    builder.apply(.connectionLost)
    finishLoop()
  }

  private func route(_ messages: [ACPInbound]) {
    for message in messages {
      switch message {
      case let .response(id, result):
        if case let .int(number) = id, number >= journal.nextRequestId {
          journal.nextRequestId = number + 1
          store.save(journal)
        }
        adoptSession(result.sessionId)
        pending.removeValue(forKey: id)?.continuation?.resume(returning: result)
      case let .clientEcho(_, .prompt(_, _, _, sessionId)), let .clientEcho(_, .load(sessionId)):
        adoptSession(sessionId)
      case let .errorResponse(id?, code, text):
        pending.removeValue(forKey: id)?.continuation?.resume(
          throwing: ACPClientError.agent(code: code, message: text))
      default:
        break
      }
    }
  }

  private func adoptSession(_ id: String?) {
    guard joining, journal.sessionId == nil, let id else { return }
    journal.sessionId = id
    store.save(journal)
  }

  private func finishLoop() {
    ended = true
    publish()
    let waiting = pending
    pending = [:]
    for entry in waiting.values { entry.continuation?.resume(throwing: ACPClientError.connectionLost) }
    for continuation in subscribers.values { continuation.finish() }
    subscribers = [:]
  }
}
