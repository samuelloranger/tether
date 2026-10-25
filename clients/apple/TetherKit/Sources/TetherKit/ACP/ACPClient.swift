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

  init(stream: any TerminalByteStream, store: any ChatJournalStore = InMemoryChatJournalStore()) {
    self.stream = stream
    self.store = store
    let journal = store.load()
    self.journal = journal
    self.builder = ChatTranscriptBuilder(journal: journal)
  }

  var state: ChatState { builder.state }
  var sessionId: String? { journal.sessionId }
  /// Bytes taken from the stream so far.
  var receivedBytes: Int { builder.receivedBytes }

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

  func prompt(text: String) async throws {
    guard let sessionId = journal.sessionId else { throw ACPClientError.noSession }
    guard !ended else { throw ACPClientError.connectionLost }
    let offset = builder.consumedOffset
    journal.entries.append(.init(kind: .prompt, offset: offset, text: text))
    builder.apply(.userPrompt(text: text, atOffset: offset))
    publish()
    store.save(journal)
    do {
      try await send(
        method: "session/prompt",
        params: ["sessionId": sessionId, "prompt": [["type": "text", "text": text]]])
    } catch {
      if let index = journal.entries.lastIndex(where: { $0.kind == .prompt && $0.offset == offset && $0.text == text }) {
        journal.entries.remove(at: index)
      }
      store.save(journal)
      builder.apply(.promptUndelivered(text: text, atOffset: offset))
      publish()
      throw error
    }
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

  func stop() async {
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

  private func request(_ method: String, _ params: [String: Any]) async throws -> ACPResult {
    let id = allocateId()
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
          builder.apply(.failure("Agent output was not valid: \(error)"))
          finishLoop()
          await stream.close()
          return
        }
        publish()
      }
    } catch {}
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
