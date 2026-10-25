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
  private var snapshotIdentity: Int?
  private let snapshotInterval: Duration
  private var lastSnapshot: ContinuousClock.Instant?
  private var wasWorking = false
  private var feedFailed = false

  /// `resume` must already be checked against the journal with `ChatSnapshot.isConsistent`; the
  /// stream is then expected to start at its offset.
  init(
    stream: any TerminalByteStream, store: any ChatJournalStore = InMemoryChatJournalStore(),
    resume: ChatSnapshot? = nil, snapshots: (any ChatSnapshotStore)? = nil, snapshotInterval: Duration = .seconds(3)
  ) {
    self.stream = stream
    self.store = store
    self.snapshotStore = snapshots
    self.snapshotIdentity = resume?.identity
    self.snapshotInterval = snapshotInterval
    let journal = store.load()
    self.journal = journal
    if let resume {
      self.builder = ChatTranscriptBuilder(journal: journal, resuming: resume)
    } else {
      self.builder = ChatTranscriptBuilder(journal: journal)
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
  /// runs `initialize` and `session/new`.
  func start(cwd: String) async throws {
    startReading()
    if journal.sessionId == nil {
      _ = try await initialize()
      _ = try await newSession(cwd: cwd)
    }
  }

  func startReading() {
    guard readTask == nil else { return }
    readTask = Task { await self.readLoop() }
  }

  func initialize() async throws -> ACPResult {
    try await request(
      "initialize",
      [
        "protocolVersion": 1,
        "clientCapabilities": ["fs": ["readTextFile": false, "writeTextFile": false], "terminal": false],
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

  func prompt(text: String, images: [ChatImageAttachment] = []) async throws {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    guard !ended else { throw ACPClientError.connectionLost }
    let offset = builder.consumedOffset
    let count = images.count
    journal.entries.append(.init(kind: .prompt, offset: offset, text: text, imageCount: count))
    builder.apply(.userPrompt(text: text, imageCount: count, atOffset: offset))
    publish()
    store.save(journal)
    var blocks: [[String: Any]] = images.map { ["type": "image", "mimeType": $0.mimeType, "data": $0.data] }
    if !text.isEmpty { blocks.append(["type": "text", "text": text]) }
    do {
      try await send(method: "session/prompt", params: ["sessionId": sessionId, "prompt": blocks])
    } catch {
      if let index = journal.entries.lastIndex(where: {
        $0.kind == .prompt && $0.offset == offset && $0.text == text && $0.imageCount == count
      }) {
        journal.entries.remove(at: index)
      }
      store.save(journal)
      builder.apply(.promptUndelivered(text: text, imageCount: count, atOffset: offset))
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

  func cancel() async throws {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    try await write(["jsonrpc": "2.0", "method": "session/cancel", "params": ["sessionId": sessionId]])
    for permission in builder.state.pendingPermissions {
      try await respond(to: permission.requestId, outcome: ["outcome": "cancelled"], optionId: "cancelled")
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

  private func respond(to id: ACPID, outcome: [String: Any], optionId: String) async throws {
    journal.entries.append(.init(kind: .answer, offset: builder.consumedOffset, requestId: id, optionId: optionId))
    builder.apply(.permissionAnswered(requestId: id, optionId: optionId))
    publish()
    store.save(journal)
    try await write(["jsonrpc": "2.0", "id": id.json, "result": ["outcome": outcome]])
  }

  private func allocateId() -> ACPID {
    let id = ACPID.int(journal.nextRequestId)
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

  private func send(method: String, params: [String: Any]) async throws {
    let id = allocateId()
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
        pending.removeValue(forKey: id)?.continuation?.resume(returning: result)
      case let .errorResponse(id?, code, text):
        pending.removeValue(forKey: id)?.continuation?.resume(
          throwing: ACPClientError.agent(code: code, message: text))
      default:
        break
      }
    }
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
